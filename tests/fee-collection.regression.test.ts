/**
 * Regression tests for the duplicate ATF platform-fee broadcast bug.
 * Scenarios A–G from the bug report, driven through the REAL
 * FeeCollectionService with in-memory model doubles (Mongo subset) and
 * overridable on-chain verifiers. Run: npm test
 */
import { FeeCollectionService } from '../../src/services/fee-collection-service';

// ── in-memory Transaction double (Mongo subset used by the service) ──
function createTxStore(seed: any[] = []) {
  const docs = seed.map((d) => ({ ...d, metadata: { ...(d.metadata || {}) } }));
  const get = (p: string, o: any) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);
  const match = (d: any, f: any): boolean =>
    !f || typeof f !== 'object' ||
    Object.entries(f).every(([k, c]: any) => {
      if (k === '$and') return c.every((x: any) => match(d, x));
      if (k === '$or') return c.some((x: any) => match(d, x));
      const v = get(k, d);
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        return Object.entries(c).every(([op, a]: any) => {
          if (op === '$in') return a.includes(v);
          if (op === '$ne') return v !== a;
          if (op === '$lte') return v != null && v <= a;
          if (op === '$lt') return v != null && v < a;
          if (op === '$exists') return a ? v !== undefined : v === undefined;
          throw new Error('unsupported op ' + op);
        });
      }
      return v === c;
    });
  const apply = (d: any, u: any) => {
    const setp = (p: string, val: any) => {
      const ks = p.split('.');
      let o = d;
      for (let i = 0; i < ks.length - 1; i++) { o[ks[i]] = o[ks[i]] || {}; o = o[ks[i]]; }
      if (val === undefined) delete o[ks[ks.length - 1]];
      else o[ks[ks.length - 1]] = val;
    };
    for (const [op, fields] of Object.entries(u)) {
      for (const [p, val] of Object.entries(fields as any)) {
        if (op === '$set' || op === '$setOnInsert') setp(p, val);
        else if (op === '$unset') setp(p, undefined);
        else if (op === '$inc') setp(p, (get(p, d) || 0) + (val as number));
        else throw new Error('unsupported update ' + op);
      }
    }
    return d;
  };
  const chain = (arr: any[]) =>
    Object.assign(arr, { sort() { return this; }, limit() { return this; }, lean() { return this; } });
  return {
    docs,
    async findById(id: string) { return docs.find((d) => d._id === id) || null; },
    async findOne(f: any) { return docs.find((d) => match(d, f)) || null; },
    async find(f: any) { return chain(docs.filter((d) => match(d, f))); },
    async findOneAndUpdate(f: any, u: any, opts: any = {}) {
      let d = docs.find((x) => match(x, f));
      if (!d && opts.upsert) {
        d = { _id: 'gen-' + docs.length };
        docs.push(d);
        apply(d, u.$setOnInsert ? { $set: u.$setOnInsert } : {});
      } else if (d) {
        apply(d, u);
      }
      return opts.new ? d : d ? JSON.parse(JSON.stringify(d)) : null;
    },
    async updateOne(f: any, u: any) {
      const d = docs.find((x) => match(x, f));
      if (d) apply(d, u);
      return { acknowledged: true, modifiedCount: d ? 1 : 0 };
    },
    async create(objs: any[]) {
      const arr = Array.isArray(objs) ? objs : [objs];
      arr.forEach((o) => docs.push(JSON.parse(JSON.stringify(o))));
      return arr;
    },
  };
}

jest.mock('../../src/services/wallet-service', () => {
  (global as any).__wallet = {
    getBalance: jest.fn(),
    getAddress: jest.fn(),
    sendJetton: jest.fn(),
    sendTon: jest.fn(),
  };
  return { WalletService: jest.fn().mockImplementation(() => (global as any).__wallet) };
});

jest.mock('../../src/config', () => ({
  config: {
    adminFeeWalletAddress: 'ADMIN',
    atfJettonAddress: 'ATFMASTER',
    tonRpcUrl: 'https://ton.example',
    tonApiKey: undefined,
    feePolicy: { tokenToTonOutputPercent: 100 },
  },
}));

jest.mock('../../src/config/fees', () => ({
  FeeEngine: { percentOf: (v: bigint, p: number) => (v * BigInt(p)) / 10000n },
}));

let mockStore: any;
jest.mock('../../src/models/Transaction', () => ({
  get Transaction() { return mockStore; },
}));

jest.mock('../../src/models/User', () => ({
  User: { findById: async () => ({ _id: 'u1', telegramId: 42 }) },
}));

class TestFeeService extends (FeeCollectionService as any) {
  jettonOutcome: any = 'delivered';
  protected async verifyJettonTransfer() { return this.jettonOutcome; }
  protected async verifyTonTransfer() {
    return this.jettonOutcome === 'bounced' ? 'bounced' : 'delivered';
  }
  async reconcileUncertainFeesPublic() { return super.reconcileUncertainFees(); }
}

const swapSeed = () => ({
  _id: 'swap-1',
  type: 'swap',
  status: 'completed',
  feeStatus: 'pending',
  userId: 'u1',
  asset: 'ATF',
  fee: '9600000000', // 9.6 ATF in base units
  feePercentage: 100,
  toAddress: 'ROUTER',
  metadata: { walletAddress: 'W1', swapDirection: 'ton_to_atf' },
});

let svc: TestFeeService;

beforeEach(() => {
  mockStore = createTxStore([swapSeed()]);
  (global as any).__wallet.getAddress.mockResolvedValue('W1');
  (global as any).__wallet.getBalance.mockResolvedValue({ ton: 500000000n, atf: 0n });
  (global as any).__wallet.sendJetton.mockResolvedValue('realhash-1');
  (global as any).__wallet.sendTon.mockResolvedValue('tonhash-1');
  svc = new TestFeeService();
});

const feeDoc = () => mockStore.docs.find((d: any) => d.type === 'fee');

/** A: delivered, then 100 sweeper ticks → exactly one broadcast. */
test('A: delivered fee survives 100 ticks with exactly one broadcast', async () => {
  expect(await svc.collectSwapFee('swap-1')).toBe('collected');
  for (let i = 0; i < 100; i++) {
    await svc.collectSwapFee('swap-1');
    await (svc as any).collectDueFees();
  }
  expect((global as any).__wallet.sendJetton).toHaveBeenCalledTimes(1);
  const swap = mockStore.docs.find((d: any) => d.type === 'swap');
  expect(swap.feeStatus).toBe('completed');
  expect(swap.feeTxHash).toBe('realhash-1');
});

/** B: bounced → no retry until bounce confirmed AND retry policy due. */
test('B: bounce blocked by cooldown, retried only under policy', async () => {
  svc.jettonOutcome = 'bounced';
  expect(await svc.collectSwapFee('swap-1')).toBe('pending');
  await svc.collectSwapFee('swap-1');
  expect((global as any).__wallet.sendJetton).toHaveBeenCalledTimes(1); // cooldown blocks
  expect(feeDoc().metadata.feeOutcome).toBe('bounced');
  feeDoc().metadata.nextRetryAt = new Date(Date.now() - 1000); // time passes
  svc.jettonOutcome = 'delivered';
  expect(await svc.collectSwapFee('swap-1')).toBe('collected');
  expect((global as any).__wallet.sendJetton).toHaveBeenCalledTimes(2);
});

/** C: insufficient TON before broadcast → nothing broadcast, bounded. */
test('C: insufficient gas → no broadcast, bounded attempts', async () => {
  (global as any).__wallet.getBalance.mockResolvedValue({ ton: 50000000n, atf: 0n }); // 0.05 TON < 0.15
  for (let i = 0; i < 6; i++) {
    await svc.collectSwapFee('swap-1');
    const f = feeDoc();
    if (f?.metadata?.nextRetryAt) f.metadata.nextRetryAt = new Date(Date.now() - 1000);
  }
  expect((global as any).__wallet.sendJetton).not.toHaveBeenCalled();
  expect(feeDoc().metadata.attempts).toBe(5); // bounded — no 6th attempt
  expect(feeDoc().metadata.feeOutcome).toBe('pre_broadcast');
});

/** D: timeout after broadcast → no replacement until reconciliation. */
test('D: ambiguous outcome never auto-retried', async () => {
  (global as any).__wallet.sendJetton.mockRejectedValue(new Error('waitForTransaction timed out'));
  for (let i = 0; i < 10; i++) await svc.collectSwapFee('swap-1');
  expect((global as any).__wallet.sendJetton).toHaveBeenCalledTimes(1);
  expect(feeDoc().metadata.feeOutcome).toBe('uncertain');
});

/** E: two workers racing → at most one broadcast. */
test('E: racing workers produce a single broadcast', async () => {
  const results = await Promise.all([
    svc.collectSwapFee('swap-1'),
    svc.collectSwapFee('swap-1'),
    svc.collectSwapFee('swap-1'),
  ]);
  expect(results.filter((r) => r === 'collected')).toHaveLength(1);
  expect((global as any).__wallet.sendJetton).toHaveBeenCalledTimes(1);
});

/** F: completed fee record with stale swap feeStatus → no broadcast. */
test('F: fee record is the authority over a stale mirror', async () => {
  mockStore.docs.push({
    _id: 'fee-1',
    type: 'fee',
    status: 'completed',
    txHash: 'realhash',
    metadata: {
      swapTxId: 'swap-1',
      feeKind: 'swap_platform_fee',
      feeKey: 'swap-1:platform',
      attempts: 1,
    },
  });
  await svc.collectSwapFee('swap-1');
  await (svc as any).collectDueFees();
  expect((global as any).__wallet.sendJetton).not.toHaveBeenCalled();
  const swap = mockStore.docs.find((d: any) => d.type === 'swap');
  expect(swap.feeStatus).toBe('completed'); // mirror re-synced from the record
  expect(swap.feeTxHash).toBe('realhash');
});

/** G: a worker attempting to mark a completed fee as failed cannot. */
test('G: completion remains terminal', async () => {
  expect(await svc.collectSwapFee('swap-1')).toBe('collected');
  svc.jettonOutcome = 'bounced'; // even a "bounce" verdict afterwards
  await svc.reconcileUncertainFeesPublic();
  await (svc as any).markPreBroadcastFailed(
    { _id: feeDoc()._id, metadata: { attempts: 1 } },
    { _id: 'swap-1' },
    'attempted overwrite'
  );
  expect(feeDoc().status).toBe('completed');
  expect(feeDoc().txHash).toBe('realhash-1');
});
