/**
 * #1378: pagination across a large result set — page mode, cursor mode,
 * and boundary chaining between pages.
 *
 * These tests use a lightweight in-memory Prisma mock so no DB is required.
 * The mock honours the same WHERE clauses `findLogs` emits:
 *   - filter fields (entity / actorId / action / timestamp range)
 *   - the cursor OR-predicate on (timestamp, id)
 */
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { AuditService, AuditQueryDto } from './audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from './metrics.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

interface Row {
  id: string;
  actorId: string;
  entity: string;
  entityId: string;
  action: string;
  timestamp: Date;
  metadata: unknown;
}

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `row-${String(i).padStart(4, '0')}`,
    actorId: 'actor-1',
    entity: 'campaign',
    entityId: 'camp-1',
    action: 'create',
    // Strictly increasing timestamps, 1 s apart.
    timestamp: new Date(1_700_000_000_000 + i * 1000),
    metadata: { i },
  }));
}

const ALL_ROWS = makeRows(250);

/**
 * Applies the WHERE clause `findLogs` builds, then sorts by
 * (timestamp DESC, id DESC) — the same order the real query uses.
 */
function applyWhere(rows: Row[], where: any): Row[] {
  let out = rows;
  if (where?.entity) out = out.filter(r => r.entity === where.entity);
  if (where?.actorId) out = out.filter(r => r.actorId === where.actorId);
  if (where?.action) out = out.filter(r => r.action === where.action);
  if (where?.timestamp) {
    if (where.timestamp.gte) out = out.filter(r => r.timestamp >= where.timestamp.gte);
    if (where.timestamp.lte) out = out.filter(r => r.timestamp <= where.timestamp.lte);
  }
  if (where?.OR) {
    // Cursor predicate: (timestamp < ts) OR (timestamp == ts AND id < id)
    const ltTs = where.OR[0].timestamp.lt as Date;
    const eqTs = where.OR[1].timestamp as Date;
    const ltId = where.OR[1].id.lt as string;
    out = out.filter(
      r =>
        r.timestamp < ltTs ||
        (r.timestamp.getTime() === eqTs.getTime() && r.id < ltId),
    );
  }
  return out;
}

const prismaMock = {
  auditLog: {
    findMany: jest.fn(
      async ({ where, orderBy, skip, take }: any) => {
        const filtered = applyWhere(ALL_ROWS, where);
        filtered.sort((a, b) => {
          const t = b.timestamp.getTime() - a.timestamp.getTime();
          if (t !== 0) return t;
          return b.id.localeCompare(a.id);
        });
        return filtered.slice(skip ?? 0, (skip ?? 0) + (take ?? 50));
      },
    ),
    count: jest.fn(async ({ where }: any) => applyWhere(ALL_ROWS, where).length),
  },
  $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
};

const metricsMock = {
  dbQueryDuration: { startTimer: () => () => undefined },
  dbErrorsTotal: { inc: () => undefined },
};

describe('AuditService pagination (#1378)', () => {
  let svc: AuditService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod = await Test.createTestingModule({
      providers: [
        AuditService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MetricsService, useValue: metricsMock },
      ],
    }).compile();
    svc = mod.get(AuditService);
  });

  it('page mode: walks all 250 rows across 5 pages with no gaps or duplicates', async () => {
    const seen = new Set<string>();
    for (let p = 1; p <= 5; p++) {
      const r = await svc.findLogs({ page: p, limit: 50 } as AuditQueryDto);
      expect(r.page).toBe(p);
      expect(r.limit).toBe(50);
      expect(r.total).toBe(250);
      expect(r.data).toHaveLength(50);
      for (const row of r.data) {
        expect(seen.has(row.id)).toBe(false);
        seen.add(row.id);
      }
    }
    expect(seen.size).toBe(250);
  });

  it('cursor mode: walks all 250 rows with no gaps, duplicates, or infinite loop', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      const r = await svc.findLogs({ cursor, limit: 50 } as AuditQueryDto);
      pages++;
      expect(pages).toBeLessThanOrEqual(6); // 5 full pages + 1 short final
      seen.push(...r.data.map(x => x.id));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(seen.length).toBe(250);
    expect(new Set(seen).size).toBe(250);
    expect(pages).toBe(5);
  });

  it('cursor mode: last page returns nextCursor=null even if it happens to be exactly limit rows', async () => {
    // 250 is exactly 5 * 50; the 5th page has 50 rows, so findLogs emits
    // a nextCursor. A 6th call must return 0 rows and nextCursor=null.
    let cursor: string | undefined;
    for (let p = 1; p <= 5; p++) {
      const r = await svc.findLogs({ cursor, limit: 50 } as AuditQueryDto);
      cursor = r.nextCursor ?? undefined;
    }
    expect(cursor).toBeDefined();
    const last = await svc.findLogs({ cursor, limit: 50 } as AuditQueryDto);
    expect(last.data).toHaveLength(0);
    expect(last.nextCursor).toBeNull();
  });

  it('rejects malformed cursor with BadRequestException', async () => {
    await expect(
      svc.findLogs({ cursor: 'not-a-cursor' } as AuditQueryDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('DTO rejects page=0 and limit=10000 (the reason AuditQuery is a class, not an interface)', async () => {
    const bad = plainToInstance(AuditQueryDto, { page: 0, limit: 10000 });
    const errors = await validate(bad);
    const props = errors.map(e => e.property).sort();
    expect(props).toEqual(['limit', 'page']);
  });

  it('DTO accepts a valid cursor / page / limit combination', async () => {
    const ok = plainToInstance(AuditQueryDto, {
      page: 2,
      limit: 100,
      cursor: '2026-01-01T00:00:00.000Z|row-0001',
    });
    const errors = await validate(ok);
    expect(errors).toHaveLength(0);
  });
});
