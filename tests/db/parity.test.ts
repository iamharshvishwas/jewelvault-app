import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LIMITS,
  PricingError,
  formatGrams,
  formatRupees,
  parseGrams,
  parseRupees,
  priceBill,
  type Material,
  type PriceBillInput,
  type PriceLineInput,
  type PricedBill,
  type SaleType,
  type SellingMethod,
} from '../../src/lib/pricing';
import { connect } from './pg';
import { apiEnv, createLogin, deleteLogin, type Login } from './rpc';

// T-A14 (the DB half; the UNIT half is tests/unit/pricing.test.ts, FE01): the integer copy of the pricing in
// src/lib/pricing.ts equals the database on 200 random inputs. DB08, migration 0015.
//
//   leg A  private.price_bill, the pure function over jsonb, called by the database owner;
//   leg B  public.quote_bill, signed in as the owner, over real designs and pieces made inside a rolled-back transaction
//          (so the piece snapshot, the round-off setting and the role check are part of the comparison);
//   leg C  the text a screen or an API call can send: pricing.ts's parseRupees / parseGrams and the database's
//          private.read_decimal accept and refuse the same texts and numbers;
//   leg D  quote_bill over HTTP with a hand-written body, to see that a trailing zero (1.230) survives the API as sent.
//
// The 200 inputs come from a seeded generator (the same 200 on every run): ordinary bills, bills built to sit on a cap (a line
// or a subtotal a few paise either side of 1,000,000,000) and bills with one fault (a negative, an over-cap value, a missing
// rate, a discount that is too big, ...). For every input both sides must either price it to the same figures, compared as the
// exact text the column would hold, or refuse it with JV_INVALID_INPUT, naming the same input and the same line.
// Nothing here writes money to the database: leg B rolls back, leg D commits one design and one piece and deletes them.

// ------------------------------------------------------------------------------------------------ the generator

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MATERIALS: readonly Material[] = ['Gold', 'Silver'];
const SALE_TYPES: readonly SaleType[] = ['Retail', 'Semi-Wholesale', 'Wholesale'];

interface Case {
  id: number;
  kind: 'normal' | 'cap' | 'fault';
  input: PriceBillInput;
  /** A fault leaves the line list or a value in a state a piece could never hold (leg B skips it). */
  note?: string;
}

function generateCases(count: number): Case[] {
  const rng = mulberry32(20261015);
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const chance = (p: number) => rng() < p;
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)];
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  // Absent, null or a value: the three ways a client can leave an optional input.
  const optional = (value: () => number): number | null | undefined => {
    const r = rng();
    return r < 0.45 ? undefined : r < 0.55 ? null : value();
  };

  const normalLine = (): PriceLineInput => {
    const material = pick(MATERIALS);
    const sellingMethod: SellingMethod = chance(0.7) ? 'By Weight' : 'Per Piece';
    const byWeight = sellingMethod === 'By Weight';
    return {
      material,
      sellingMethod,
      customerNetWeightMg: chance(0.05) ? 0 : chance(0.6) ? int(1, 60_000) : int(1, 800_000),
      quantity: byWeight
        ? (pick([undefined, undefined, null, 1]) as number | null | undefined)
        : chance(0.3)
          ? undefined
          : chance(0.8)
            ? int(1, 12)
            : int(1, 1000),
      metalRatePaise: byWeight
        ? chance(0.5)
          ? int(500_000, 1_100_000)
          : int(0, 20_000_000)
        : int(0, 50_000_000),
      // a Per Piece line ignores its labour rate, so any value goes there, a negative one included
      labourRatePaise: byWeight
        ? int(0, 3_000_000)
        : (pick([undefined, null, 0, 2500, -7]) as number | null | undefined),
      piroiPaise: optional(() => int(0, 20_000)),
      otherChargesPaise: optional(() => int(0, 20_000)),
    };
  };

  // A line whose amount lies within a few paise of the cap of 1,000,000,000 (100,000,000,000 paise).
  const capLine = (): PriceLineInput => {
    const material = pick(MATERIALS);
    if (chance(0.5)) {
      const rate = int(1_000_000, LIMITS.maxRatePaise);
      const base = Math.floor((LIMITS.maxAmountPaise * 1000) / rate);
      return {
        material,
        sellingMethod: 'By Weight',
        customerNetWeightMg: clamp(base + int(-2, 2), 0, LIMITS.maxWeightMg),
        metalRatePaise: rate,
        labourRatePaise: pick([0, 0, 1, 100]),
        piroiPaise: optional(() => int(0, 3)),
        otherChargesPaise: optional(() => int(0, 3)),
      };
    }
    const quantity = int(10, 1000);
    return {
      material,
      sellingMethod: 'Per Piece',
      customerNetWeightMg: int(0, 5000),
      quantity,
      metalRatePaise: clamp(
        Math.floor(LIMITS.maxAmountPaise / quantity) + int(-2, 2),
        0,
        LIMITS.maxRatePaise
      ),
      piroiPaise: optional(() => int(0, 3)),
      otherChargesPaise: optional(() => int(0, 3)),
    };
  };

  // Charges and the discount, chosen once the lines are known: the discount is somewhere in [0, subtotal + additional], now
  // and then exactly the whole of it, or one paisa more.
  const withMoney = (saleType: SaleType, lines: PriceLineInput[]): PriceBillInput => {
    const roundOffSetting = chance(0.5);
    const additionalChargesPaise = optional(() =>
      chance(0.3) ? int(0, 20_000_000) : int(0, 99_999)
    );
    let subtotal = 0;
    try {
      subtotal = priceBill({ saleType, lines, roundOffSetting }).subtotalPaise;
    } catch {
      // the lines themselves are refused: whatever the discount, the bill is refused
    }
    const room = subtotal + (additionalChargesPaise ?? 0);
    const r = rng();
    const discountPaise: number | null | undefined =
      r < 0.35
        ? undefined
        : r < 0.4
          ? null
          : r < 0.6
            ? 0
            : r < 0.85
              ? int(0, Math.max(0, room))
              : r < 0.93
                ? room
                : room + 1;
    return { saleType, lines, discountPaise, additionalChargesPaise, roundOffSetting };
  };

  const cases: Case[] = [];
  for (let id = 0; id < count; id += 1) {
    const slot = id % 10;
    const saleType = pick(SALE_TYPES);
    if (slot < 6) {
      const lines = Array.from({ length: int(1, 6) }, normalLine);
      cases.push({ id, kind: 'normal', input: withMoney(saleType, lines) });
    } else if (slot < 8) {
      const lines = Array.from({ length: int(1, 3) }, () =>
        chance(0.7) ? capLine() : normalLine()
      );
      cases.push({ id, kind: 'cap', input: withMoney(saleType, lines) });
    } else {
      // one fault in an otherwise ordinary bill
      const lines = Array.from({ length: int(1, 4) }, normalLine);
      const input = withMoney(saleType, lines);
      const line = pick(lines);
      const byWeight = line.sellingMethod === 'By Weight';
      const faults: Array<[string, () => void]> = [
        ['negative weight', () => (line.customerNetWeightMg = -int(1, 5000))],
        ['weight over the cap', () => (line.customerNetWeightMg = LIMITS.maxWeightMg + int(1, 50))],
        ['quantity 0', () => (line.quantity = 0)],
        ['quantity 1001', () => (line.quantity = 1001)],
        ['negative quantity', () => (line.quantity = -int(1, 5))],
        ['metal rate negative', () => (line.metalRatePaise = -int(1, 90_000))],
        ['metal rate over the cap', () => (line.metalRatePaise = LIMITS.maxRatePaise + int(1, 50))],
        ['metal rate missing', () => (line.metalRatePaise = undefined as unknown as number)],
        ['piroi negative', () => (line.piroiPaise = -int(1, 900))],
        ['piroi over the cap', () => (line.piroiPaise = LIMITS.maxAmountPaise + int(1, 50))],
        ['other charges negative', () => (line.otherChargesPaise = -int(1, 900))],
        ['other charges over the cap', () => (line.otherChargesPaise = LIMITS.maxAmountPaise + 1)],
        ['discount negative', () => (input.discountPaise = -int(1, 900))],
        ['discount over the cap', () => (input.discountPaise = LIMITS.maxAmountPaise + int(1, 50))],
        ['additional negative', () => (input.additionalChargesPaise = -int(1, 900))],
        [
          'additional over the cap',
          () => (input.additionalChargesPaise = LIMITS.maxAmountPaise + 1),
        ],
        ['no lines', () => (input.lines = [])],
        ['201 lines', () => (input.lines = Array.from({ length: 201 }, () => lines[0]))],
      ];
      if (byWeight) {
        faults.push(['By Weight quantity 2', () => (line.quantity = int(2, 9))]);
        faults.push(['labour rate missing', () => (line.labourRatePaise = undefined)]);
        faults.push(['labour rate null', () => (line.labourRatePaise = null)]);
        faults.push(['labour rate negative', () => (line.labourRatePaise = -int(1, 90_000))]);
        faults.push([
          'labour rate over the cap',
          () => (line.labourRatePaise = LIMITS.maxRatePaise + int(1, 50)),
        ]);
      }
      const [note, apply] = pick(faults);
      apply();
      cases.push({ id, kind: 'fault', input, note });
    }
  }
  return cases;
}

// ------------------------------------------------------------------------------------------------ what each side says

interface FlatBill {
  subtotal: string;
  discount: string;
  additional_charges: string;
  before_round: string;
  grand_total: string;
  round_off: string;
  fine_weight_due: string;
  /** per line: quantity, piroi, other_charges, labour_amount, metal_amount, fine_weight_due, item_total */
  lines: string[][];
}

type Outcome = { ok: true; bill: FlatBill } | { ok: false; message: string };

/** The figures of pricing.ts as the exact text the database column holds (two decimals, three for a weight). */
function flatten(bill: PricedBill): FlatBill {
  return {
    subtotal: formatRupees(bill.subtotalPaise),
    discount: formatRupees(bill.discountPaise),
    additional_charges: formatRupees(bill.additionalChargesPaise),
    before_round: formatRupees(bill.beforeRoundPaise),
    grand_total: formatRupees(bill.grandTotalPaise),
    round_off: formatRupees(bill.roundOffPaise),
    fine_weight_due: formatGrams(bill.fineWeightDueMg),
    lines: bill.lines.map((line) => [
      String(line.quantity),
      formatRupees(line.piroiPaise),
      formatRupees(line.otherChargesPaise),
      formatRupees(line.labourAmountPaise),
      formatRupees(line.metalAmountPaise),
      formatGrams(line.fineWeightDueMg),
      formatRupees(line.itemTotalPaise),
    ]),
  };
}

function runIntegerCopy(
  input: PriceBillInput
): { ok: true; bill: FlatBill } | { ok: false; error: PricingError } {
  try {
    return { ok: true, bill: flatten(priceBill(input)) };
  } catch (error) {
    if (error instanceof PricingError) return { ok: false, error };
    throw error;
  }
}

/** A decimal as JSON holds it: sometimes a number, sometimes the text, both read exactly by the database. */
function decimal(rng: () => number, units: number | null | undefined, scale: 2 | 3): unknown {
  if (units === undefined) return undefined;
  if (units === null) return null;
  const text = scale === 2 ? formatRupees(units) : formatGrams(units);
  return rng() < 0.5 ? text : Number(text);
}

/** The line as the database reads it (D12 snapshot keys). `undefined` leaves the key out of the JSON. */
function databaseLine(rng: () => number, line: PriceLineInput): Record<string, unknown> {
  return {
    material: line.material,
    selling_method: line.sellingMethod,
    customer_net_weight: decimal(rng, line.customerNetWeightMg, 3),
    quantity: line.quantity,
    metal_rate: decimal(rng, line.metalRatePaise, 2),
    labour_rate: decimal(rng, line.labourRatePaise, 2),
    piroi: decimal(rng, line.piroiPaise, 2),
    other_charges: decimal(rng, line.otherChargesPaise, 2),
  };
}

const money = (units: number | null | undefined): string | null =>
  units === undefined || units === null ? null : formatRupees(units);

/** The columns of a priced bill, read as text so the two decimals of 245106.40 are not lost on the way. */
const FLAT_COLUMNS = `
  j ->> 'subtotal' as subtotal, j ->> 'discount' as discount, j ->> 'additional_charges' as additional_charges,
  j ->> 'before_round' as before_round, j ->> 'grand_total' as grand_total, j ->> 'round_off' as round_off,
  j ->> 'fine_weight_due' as fine_weight_due,
  (select jsonb_agg(jsonb_build_array(l ->> 'quantity', l ->> 'piroi', l ->> 'other_charges', l ->> 'labour_amount',
                                      l ->> 'metal_amount', l ->> 'fine_weight_due', l ->> 'item_total') order by n)
     from jsonb_array_elements(j -> 'lines') with ordinality as t(l, n)) as lines`;

async function runDatabase(
  client: Client,
  sql: string,
  params: unknown[],
  savepoint: boolean
): Promise<Outcome> {
  if (savepoint) await client.query('savepoint parity');
  try {
    const { rows } = await client.query(sql, params);
    if (savepoint) await client.query('release savepoint parity');
    return { ok: true, bill: rows[0] as FlatBill };
  } catch (error) {
    if (savepoint) await client.query('rollback to savepoint parity');
    const message = (error as Error).message;
    if (!message.startsWith('JV_INVALID_INPUT')) throw error;
    return { ok: false, message };
  }
}

const PURE_SQL = `select ${FLAT_COLUMNS}
  from (select private.price_bill(1, $1, $2::jsonb, $3::numeric, $4::numeric, $5::boolean) as j) x`;

// The words of the database's message for each input pricing.ts names, and the line the message points at.
const FIELD_WORDS: Record<string, string> = {
  material: 'material',
  sellingMethod: 'selling_method',
  customerNetWeightMg: 'customer_net_weight',
  quantity: 'quantity',
  metalRatePaise: 'metal_rate',
  labourRatePaise: 'labour_rate',
  piroiPaise: 'piroi',
  otherChargesPaise: 'other_charges',
  metalAmountPaise: 'the metal amount',
  labourAmountPaise: 'the labour amount',
  itemTotalPaise: 'the line total',
  subtotalPaise: 'the subtotal',
  grandTotalPaise: 'the grand total',
  discountPaise: 'discount',
  additionalChargesPaise: 'additional_charges',
  lines: 'a bill needs',
};

/** True when the database refused the same input as pricing.ts did: the same field of the same line. */
function sameRefusal(error: PricingError, message: string): boolean {
  const parts = /^lines\[(\d+)\]\.(.+)$/.exec(error.field);
  const key = parts ? parts[2] : error.field;
  const prefix = parts ? `line ${Number(parts[1]) + 1}: ` : '';
  const word = FIELD_WORDS[key];
  if (!word) return false;
  if (!message.startsWith(`JV_INVALID_INPUT: ${prefix}`)) return false;
  if (!parts && /^JV_INVALID_INPUT: line \d+:/.test(message)) return false;
  return message.includes(word);
}

function describeCase(c: Case): string {
  return `#${c.id} ${c.kind}${c.note ? ` (${c.note})` : ''}`;
}

/** Compares one input; returns what differs, or null. */
function compare(
  c: Case,
  copy: ReturnType<typeof runIntegerCopy>,
  database: Outcome
): string | null {
  if (copy.ok && database.ok) {
    return JSON.stringify(copy.bill) === JSON.stringify(normalise(database.bill))
      ? null
      : `${describeCase(c)}: priced differently\n  pricing.ts ${JSON.stringify(copy.bill)}\n  database   ${JSON.stringify(normalise(database.bill))}`;
  }
  if (!copy.ok && !database.ok) {
    return sameRefusal(copy.error, database.message)
      ? null
      : `${describeCase(c)}: both refuse, not the same input\n  pricing.ts ${copy.error.message}\n  database   ${database.message}`;
  }
  return copy.ok
    ? `${describeCase(c)}: pricing.ts prices it, the database refuses: ${(database as { message: string }).message}`
    : `${describeCase(c)}: the database prices it, pricing.ts refuses: ${copy.error.message}`;
}

function normalise(bill: FlatBill): FlatBill {
  return {
    subtotal: bill.subtotal,
    discount: bill.discount,
    additional_charges: bill.additional_charges,
    before_round: bill.before_round,
    grand_total: bill.grand_total,
    round_off: bill.round_off,
    fine_weight_due: bill.fine_weight_due,
    lines: bill.lines,
  };
}

// ------------------------------------------------------------------------------------------------ the suites

const CASES = generateCases(200);
let admin: Client;

beforeAll(async () => {
  admin = await connect('parity');
});

afterAll(async () => {
  await admin?.end();
});

function summary(copies: Array<ReturnType<typeof runIntegerCopy>>) {
  const priced = copies.filter((c) => c.ok) as Array<{ ok: true; bill: FlatBill }>;
  return {
    accepted: priced.length,
    refused: copies.length - priced.length,
    withFine: priced.filter((c) => c.bill.fine_weight_due !== '0.000').length,
    negativeRoundOff: priced.filter((c) => c.bill.round_off.startsWith('-')).length,
    positiveRoundOff: priced.filter((c) => /^[1-9]|^0\.0*[1-9]/.test(c.bill.round_off)).length,
    withDiscount: priced.filter((c) => c.bill.discount !== '0.00').length,
  };
}

describe('T-A14 leg A: pricing.ts and private.price_bill on 200 random inputs', () => {
  it('the generator makes 200 inputs, of every kind, and a fair share of them are priced and of them refused', () => {
    expect(CASES).toHaveLength(200);
    const copies = CASES.map((c) => runIntegerCopy(c.input));
    const s = summary(copies);
    expect(s.accepted).toBeGreaterThan(100);
    expect(s.refused).toBeGreaterThan(20);
    expect(s.withFine).toBeGreaterThan(5);
    expect(s.negativeRoundOff).toBeGreaterThan(5);
    expect(s.positiveRoundOff).toBeGreaterThan(5);
    expect(s.withDiscount).toBeGreaterThan(20);
    // cap bills were built to sit on the line: some are priced, some refused
    const caps = CASES.map((c, i) => ({ c, r: copies[i] })).filter((x) => x.c.kind === 'cap');
    expect(caps.filter((x) => x.r.ok).length).toBeGreaterThan(2);
    expect(caps.filter((x) => !x.r.ok).length).toBeGreaterThan(2);
  });

  it('equal figures, to the paisa and the milligram, or the same refusal, on every one', async () => {
    const rng = mulberry32(77);
    const differences: string[] = [];
    for (const c of CASES) {
      const copy = runIntegerCopy(c.input);
      const lines = c.input.lines.map((line) => databaseLine(rng, line));
      const database = await runDatabase(
        admin,
        PURE_SQL,
        [
          c.input.saleType,
          JSON.stringify(lines),
          money(c.input.discountPaise),
          money(c.input.additionalChargesPaise),
          c.input.roundOffSetting,
        ],
        false
      );
      const difference = compare(c, copy, database);
      if (difference) differences.push(difference);
    }
    expect(differences, differences.slice(0, 5).join('\n')).toEqual([]);
  });
});

describe('T-A14 leg A: the edges, fixed', () => {
  const line = (over: Partial<PriceLineInput>): PriceLineInput => ({
    material: 'Gold',
    sellingMethod: 'By Weight',
    customerNetWeightMg: 10_000,
    metalRatePaise: 692_000,
    labourRatePaise: 35_300,
    ...over,
  });
  const bill = (lines: PriceLineInput[], over: Partial<PriceBillInput> = {}): PriceBillInput => ({
    saleType: 'Retail',
    lines,
    roundOffSetting: true,
    ...over,
  });
  const edges: Array<[string, PriceBillInput]> = [
    [
      'the worked example',
      bill([
        line({
          customerNetWeightMg: 35_420,
          metalRatePaise: 692_000,
          labourRatePaise: 35_300,
          piroiPaise: 215,
        }),
      ]),
    ],
    [
      'wholesale silver by weight',
      bill(
        [
          line({
            material: 'Silver',
            customerNetWeightMg: 13_900,
            metalRatePaise: 8_500,
            labourRatePaise: 4_000,
          }),
        ],
        {
          saleType: 'Wholesale',
        }
      ),
    ],
    [
      '100,000 g at 100,000,000',
      bill([
        line({
          customerNetWeightMg: 100_000_000,
          metalRatePaise: 10_000_000_000,
          labourRatePaise: 0,
        }),
      ]),
    ],
    [
      'exactly 1,000,000,000',
      bill([
        line({ customerNetWeightMg: 100_000_000, metalRatePaise: 1_000_000, labourRatePaise: 0 }),
      ]),
    ],
    [
      'one paisa more',
      bill([
        line({
          customerNetWeightMg: 100_000_000,
          metalRatePaise: 1_000_000,
          labourRatePaise: 0,
          piroiPaise: 1,
        }),
      ]),
    ],
    ['200 lines', bill(Array.from({ length: 200 }, () => line({})))],
    ['201 lines', bill(Array.from({ length: 201 }, () => line({})))],
    ['no lines', bill([])],
    // 10 g at 6,920 is 69,200.00 and 10 g at 353 is 3,530.00: a discount of 72,730.00 takes the whole subtotal
    ['a discount equal to the subtotal', bill([line({})], { discountPaise: 7_273_000 })],
    ['a discount one paisa over the subtotal', bill([line({})], { discountPaise: 7_273_001 })],
    ['a discount that leaves a paisa', bill([line({})], { discountPaise: 7_272_999 })],
    [
      'a tie rounds up: 4.6 g at 92.50',
      bill([line({ customerNetWeightMg: 4_600, metalRatePaise: 9_250, labourRatePaise: 0 })]),
    ],
    [
      'a tie in the line: 0.995 g at 50.50',
      bill([line({ customerNetWeightMg: 995, metalRatePaise: 5_050, labourRatePaise: 0 })]),
    ],
  ];
  it.each(edges)('%s', async (_name, input) => {
    const rng = mulberry32(5);
    const copy = runIntegerCopy(input);
    const database = await runDatabase(
      admin,
      PURE_SQL,
      [
        input.saleType,
        JSON.stringify(input.lines.map((l) => databaseLine(rng, l))),
        money(input.discountPaise),
        money(input.additionalChargesPaise),
        input.roundOffSetting,
      ],
      false
    );
    expect(compare({ id: -1, kind: 'cap', input }, copy, database)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ leg B: quote_bill

describe('T-A14 leg B: pricing.ts and public.quote_bill, signed in, over real pieces', () => {
  it('equal figures, or the same refusal, on every input a piece can hold', async () => {
    const client = await connect('parity-quote');
    const rng = mulberry32(99);
    const differences: string[] = [];
    let compared = 0;
    try {
      await client.query('begin');
      const owner = (await client.query("select tests.make_user('owner') as id")).rows[0]
        .id as string;
      const designs = new Map<string, string>();
      for (const material of MATERIALS) {
        for (const method of ['By Weight', 'Per Piece']) {
          const made = await client.query('select tests.make_design($1::jsonb) as id', [
            JSON.stringify({
              material,
              purity: material === 'Gold' ? '22K' : '925',
              selling_method: method,
            }),
          ]);
          designs.set(`${material}|${method}`, made.rows[0].id);
        }
      }

      // a piece can hold a weight from 0 to 100,000 g (a By Weight piece above 0), so inputs outside that never reach a quote
      const holdable = (line: PriceLineInput) =>
        Number.isSafeInteger(line.customerNetWeightMg) &&
        line.customerNetWeightMg <= LIMITS.maxWeightMg &&
        line.customerNetWeightMg >= (line.sellingMethod === 'By Weight' ? 1 : 0);
      const eligible = CASES.filter(
        (c) => c.input.lines.length > 0 && c.input.lines.every(holdable)
      );
      expect(eligible.length).toBeGreaterThan(150);

      const designIds: string[] = [];
      const skuNos: string[] = [];
      const weights: string[] = [];
      for (const c of eligible) {
        c.input.lines.forEach((line, index) => {
          designIds.push(designs.get(`${line.material}|${line.sellingMethod}`) as string);
          skuNos.push(`PAR-${c.id}-${index}`);
          weights.push(formatGrams(line.customerNetWeightMg));
        });
      }
      const inserted = await client.query(
        `insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight,
                                  labour_retail, labour_semi, labour_wholesale)
         select t.design::uuid, t.sku_no, 'BC-' || t.sku_no, 0, t.nw::numeric, 1, 1, 1
           from unnest($1::text[], $2::text[], $3::text[]) as t(design, sku_no, nw)
         returning id, sku_no`,
        [designIds, skuNos, weights]
      );
      const skuIds = new Map<string, string>(
        inserted.rows.map((row: { id: string; sku_no: string }) => [row.sku_no, row.id])
      );
      const today = (await client.query('select private.today()::text as d')).rows[0].d as string;

      for (const roundOff of [true, false]) {
        await client.query('select tests.reset_role()');
        await client.query(
          `insert into public.settings (key, value) values ('estimate', $1::jsonb)
           on conflict (key) do update set value = excluded.value`,
          [JSON.stringify({ roundOff })]
        );
        await client.query('select tests.as_user($1)', [owner]);
        for (const c of eligible.filter((x) => x.input.roundOffSetting === roundOff)) {
          const copy = runIntegerCopy(c.input);
          const items = c.input.lines.map((line, index) => ({
            sku_id: skuIds.get(`PAR-${c.id}-${index}`),
            ...databaseLine(rng, line),
            material: undefined,
            selling_method: undefined,
            customer_net_weight: undefined,
          }));
          const database = await runDatabase(
            client,
            `select ${FLAT_COLUMNS}
               from (select public.quote_bill($1::date, $2, $3::jsonb, $4::numeric, $5::numeric) as j) x`,
            [
              today,
              c.input.saleType,
              JSON.stringify(items),
              money(c.input.discountPaise),
              money(c.input.additionalChargesPaise),
            ],
            true
          );
          compared += 1;
          const difference = compare(c, copy, database);
          if (difference) differences.push(difference);
        }
      }
    } finally {
      await client.query('rollback').catch(() => undefined);
      await client.end();
    }
    expect(compared).toBeGreaterThan(150);
    expect(differences, differences.slice(0, 5).join('\n')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ leg C: the text

describe('T-A14 leg C: pricing.ts and private.read_decimal read the same texts and numbers', () => {
  const texts: string[] = [
    '0',
    '0.0',
    '00',
    '007',
    '1',
    '1.',
    '.5',
    '.',
    '',
    ' ',
    '  12.5  ',
    '12.5\n',
    '\t12.5',
    ' 12.5',
    '12.5 ',
    '﻿12.5',
    '​12.5',
    '-0',
    '-0.0',
    '-1',
    '-.5',
    '+1',
    '1e3',
    '1E3',
    '0x10',
    'abc',
    '1,000',
    '1 000',
    'NaN',
    'Infinity',
    '-Infinity',
    '1.23',
    '1.230',
    '1.2300',
    '12.345',
    '1.2345',
    '99999999.99',
    '999999999.99',
    '1000000000',
    '1000000000.00',
    '1000000000.01',
    '100000',
    '100000.000',
    '100000.001',
    '٣',
    '１２',
    '1.2.3',
    '--1',
    '1-',
    '١٢٣',
    '1_000',
    '0.1',
    '0.10',
    '123456789012.34',
    '9007199254740993',
  ];
  const numbers: number[] = [
    0,
    -0,
    1,
    1.5,
    0.1,
    0.1 + 0.2,
    12.25,
    100000,
    100000.001,
    1e9,
    1e9 + 0.01,
    1e21,
    1e-7,
    5e-324,
    -3,
    123456789.123,
  ];

  const capFor = (scale: 2 | 3) => (scale === 2 ? LIMITS.maxAmountPaise : LIMITS.maxWeightMg);
  const capText = (scale: 2 | 3) => (scale === 2 ? '1000000000' : '100000');

  function integerCopy(input: string | number, scale: 2 | 3): number | null {
    try {
      const units = scale === 2 ? parseRupees(input) : parseGrams(input);
      return units <= capFor(scale) ? units : null;
    } catch (error) {
      if (error instanceof PricingError) return null;
      throw error;
    }
  }

  async function database(input: string | number, scale: 2 | 3): Promise<number | null> {
    try {
      const { rows } = await admin.query(
        "select private.read_decimal($1::jsonb, 'x', $2, $3::numeric)::text as v",
        [JSON.stringify(input), scale, capText(scale)]
      );
      const value: string | null = rows[0].v;
      if (value === null) return null;
      return scale === 2 ? parseRupees(value) : parseGrams(value);
    } catch (error) {
      if (!(error as Error).message.startsWith('JV_INVALID_INPUT')) throw error;
      return null;
    }
  }

  for (const scale of [2, 3] as const) {
    it(`as a rate or amount (2 decimals) / a weight (3 decimals): scale ${scale}`, async () => {
      const differences: string[] = [];
      for (const input of [...texts, ...numbers]) {
        const copy = integerCopy(input, scale);
        const db = await database(input, scale);
        if (copy !== db) {
          differences.push(`${JSON.stringify(input)}: pricing.ts ${copy}, database ${db}`);
        }
      }
      expect(differences).toEqual([]);
    });
  }

  it('a trailing zero counts: 1.230 is refused as a rate and accepted as a weight, 1.2300 is refused as a weight', async () => {
    expect(await database('1.230', 2)).toBeNull();
    expect(await database('1.230', 3)).toBe(1230);
    expect(await database('1.2300', 3)).toBeNull();
    expect(integerCopy('1.230', 2)).toBeNull();
    expect(integerCopy('1.230', 3)).toBe(1230);
    expect(integerCopy('1.2300', 3)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ leg D: over HTTP

describe('T-A14 leg D: quote_bill over HTTP keeps the number as it was sent', () => {
  const logins: Login[] = [];
  let skuId = '';
  let designId = '';
  let categoryId = '';

  async function post(
    who: Login | null,
    body: string
  ): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const env = apiEnv();
    const headers: Record<string, string> = {
      apikey: env.publishableKey,
      'content-type': 'application/json',
    };
    if (who) headers.authorization = `Bearer ${who.accessToken}`;
    const deadline = Date.now() + 5000;
    for (;;) {
      const response = await fetch(`${env.apiUrl}/rest/v1/rpc/quote_bill`, {
        method: 'POST',
        headers,
        body,
      });
      const text = await response.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      // a function made a moment ago may not be in the API's schema cache yet
      if (response.status === 404 && json?.code === 'PGRST202' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      return { status: response.status, json };
    }
  }

  const bodyWith = (item: string, extra = '') =>
    `{"p_bill_date": null, "p_sale_type": "Retail", "p_items": [${item}]${extra}}`;

  beforeAll(async () => {
    categoryId = (await admin.query('select tests.make_category() as id')).rows[0].id;
    designId = (
      await admin.query(
        `select tests.make_design(jsonb_build_object('category_id', $1::uuid, 'material', 'Gold', 'purity', '22K',
                                                      'selling_method', 'By Weight')) as id`,
        [categoryId]
      )
    ).rows[0].id;
    skuId = (
      await admin.query(
        `select tests.make_piece($1::uuid, '{"gross_weight": 20, "customer_net_weight": 10.000}'::jsonb) as id`,
        [designId]
      )
    ).rows[0].id;
    logins.push(await createLogin({ appRole: 'owner' }));
    logins.push(await createLogin({ appRole: 'biller' }));
    logins.push(await createLogin({ appRole: 'staff' }));
  });

  afterAll(async () => {
    for (const login of logins) await deleteLogin(login.id).catch(() => undefined);
    if (skuId) await admin.query('delete from public.skus where id = $1', [skuId]);
    if (designId) await admin.query('delete from public.designs where id = $1', [designId]);
    if (categoryId) await admin.query('delete from public.categories where id = $1', [categoryId]);
  });

  it('prices a piece for the owner and for the biller, and a number written 353.00 is fine as a rate', async () => {
    for (const who of [logins[0], logins[1]]) {
      const res = await post(
        who,
        bodyWith(`{"sku_id": "${skuId}", "metal_rate": 6920.50, "labour_rate": 353.00}`)
      );
      expect(res.status).toBe(200);
      // the answer is JSON, so the numbers arrive as numbers: 10 g x 6,920.50 = 69,205.00; 10 g x 353.00 = 3,530.00
      expect((res.json as { grand_total?: number }).grand_total).toBe(72735);
      const lines = (res.json as { lines: Array<Record<string, number>> }).lines;
      expect(lines[0].metal_amount).toBe(69205);
      expect(lines[0].labour_amount).toBe(3530);
    }
  });

  it('refuses a rate sent as 1.230 or 353.000 (a trailing zero counts), as a number and as text', async () => {
    const owner = logins[0];
    for (const item of [
      `{"sku_id": "${skuId}", "metal_rate": 1.230, "labour_rate": 353}`,
      `{"sku_id": "${skuId}", "metal_rate": 6920, "labour_rate": 353.000}`,
      `{"sku_id": "${skuId}", "metal_rate": "1.230", "labour_rate": 353}`,
      `{"sku_id": "${skuId}", "metal_rate": 6920, "labour_rate": 353, "piroi": 2.150}`,
    ]) {
      const res = await post(owner, bodyWith(item));
      expect(res.status, item).toBe(400);
      expect(String((res.json as { message?: string }).message), item).toMatch(
        /^JV_INVALID_INPUT: line 1: .* has more than 2 decimals$/
      );
    }
    const discount = await post(
      owner,
      bodyWith(
        `{"sku_id": "${skuId}", "metal_rate": 6920, "labour_rate": 353}`,
        ', "p_discount": 1.230'
      )
    );
    expect(discount.status).toBe(400);
    expect(String((discount.json as { message?: string }).message)).toMatch(
      /^JV_INVALID_INPUT: discount has more than 2 decimals$/
    );
    const fine = await post(
      owner,
      bodyWith(
        `{"sku_id": "${skuId}", "metal_rate": 6920, "labour_rate": 353}`,
        ', "p_discount": 10.50'
      )
    );
    expect(fine.status).toBe(200);
  });

  it('refuses a value over a cap with JV_INVALID_INPUT, never a numeric overflow', async () => {
    const res = await post(
      logins[0],
      bodyWith(`{"sku_id": "${skuId}", "metal_rate": 100000000, "labour_rate": 100000000}`)
    );
    expect(res.status).toBe(400);
    expect(String((res.json as { message?: string }).message)).toMatch(
      /^JV_INVALID_INPUT: line 1: the line total is above the cap/
    );
  });

  it('staff are refused with JV_FORBIDDEN, and a caller with no login cannot call it at all', async () => {
    const item = `{"sku_id": "${skuId}", "metal_rate": 6920, "labour_rate": 353}`;
    const staff = await post(logins[2], bodyWith(item));
    expect(staff.status).toBe(400);
    expect(String((staff.json as { message?: string }).message)).toMatch(/^JV_FORBIDDEN: /);
    const anon = await post(null, bodyWith(item));
    expect([401, 403]).toContain(anon.status);
    expect((anon.json as { code?: string }).code).toBe('42501');
  });
});
