// PBI6: 「記録に失敗したら業務も失敗する」ことの単体テスト。
// docs/api/pbi-6.md「同時実行・失敗時の挙動」／PO判断（e2eではなくServiceの単体テストで確認する）。
//
// 方法：
// - PrismaService を「トランザクションを模したフェイク」に差し替える。
//   `$transaction(cb)` は tx を作って cb を実行し、cb が成功したときだけ tx 内の書き込みを
//   「コミット済み」に反映する。cb が例外を投げたら破棄する（ロールバック）。
//   一方、`prisma.xxx` を直接呼んだ書き込み（＝Txの外）は即コミットされる。
// - 監査ログの記録（AuditLogService.record）を失敗させたとき、
//   (1) 業務の書き込みは tx 内で実行されていた（attempted に残る＝テストが空振りでない）、
//   (2) しかしコミットされた書き込みは0件（ロールバックされた）、
//   (3) 呼び出し元には例外が伝わる、
//   (4) record は同じ tx で呼ばれた、
//   ことを確認する。
// - 記録の失敗は2通りで再現する：record 自体を例外にする／実物の record の中の
//   tx.auditLog.create（DB書き込み）を失敗させる。
// - 対になる「記録が成功すれば業務の書き込みがコミットされる」ケースも置く（偶然PASS防止）。
import * as argon2 from 'argon2';
import { AuditLogService } from './audit-log.service';
import { ExpensesService } from '../expenses/expenses.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { RolesService } from '../admin/roles.service';
import { AuthService } from '../auth/auth.service';
import { SessionsService } from '../auth/sessions.service';
import { ExpenseCategory, ExpenseStatus, RoleName } from '@expense/shared';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const EXPENSE_ID = '33333333-3333-4333-8333-333333333333';
const ROLE_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const IP = '127.0.0.1';

function expenseRow(status: string) {
  return {
    id: EXPENSE_ID,
    applicantId: OTHER_ID,
    approverId: USER_ID,
    expenseDate: new Date('2026-11-20'),
    amount: 1500,
    category: ExpenseCategory.TRANSPORTATION,
    description: 'テスト',
    status,
    returnReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

interface FakeClient {
  __log: string[];
  [key: string]: unknown;
}

// 書き込みメソッドは呼ばれたら log に '<モデル>.<メソッド>' を積む。
// 読み取りは canned の値を返す。
interface FakeOptions {
  expenseStatus?: string;
  userRow?: unknown;
  // 実物の AuditLogService.record の中の tx.auditLog.create（DB書き込み）を失敗させる。
  auditCreateError?: Error;
}

function createFake(opts: FakeOptions) {
  const committed: string[] = [];
  const attempted: string[] = []; // Tx内で実行された書き込み（ロールバックされても残る）
  const txs: FakeClient[] = [];

  const row = expenseRow(opts.expenseStatus ?? ExpenseStatus.DRAFT);
  // 申請者として操作するケース用に、applicantId=操作者の行も返せるようにする。
  const ownRow = { ...row, applicantId: USER_ID, approverId: OTHER_ID };

  const makeClient = (log: string[], inTx: boolean): FakeClient => {
    const write =
      (name: string, result: unknown) => async (): Promise<unknown> => {
        log.push(name);
        if (inTx) attempted.push(name);
        return result;
      };
    return {
      __log: log,
      expenseRequest: {
        create: write('expenseRequest.create', ownRow),
        updateMany: write('expenseRequest.updateMany', { count: 1 }),
        deleteMany: write('expenseRequest.deleteMany', { count: 1 }),
        findFirst: jest.fn(
          async (args: { where?: { applicantId?: unknown } }) =>
            // 承認者側の検索（applicantId: { not: ... }）は申請者が別人の行、
            // 申請者側の検索（applicantId: 文字列）は本人の行を返す。
            typeof args?.where?.applicantId === 'string' ? ownRow : row,
        ),
      },
      user: {
        findUnique: jest.fn(async () => opts.userRow ?? null),
        update: write('user.update', {}),
      },
      role: {
        findUnique: jest.fn(async () => ({
          id: ROLE_ID,
          name: RoleName.MANAGER,
        })),
      },
      userRole: {
        findUnique: jest.fn(async () => ({ id: 'ur-1' })),
        findMany: jest.fn(async () => []),
        createMany: write('userRole.createMany', { count: 1 }),
        deleteMany: write('userRole.deleteMany', { count: 1 }),
      },
      session: {
        create: write('session.create', { id: SESSION_ID }),
        updateMany: write('session.updateMany', { count: 1 }),
      },
      auditLog: {
        create: async (): Promise<unknown> => {
          if (opts.auditCreateError) throw opts.auditCreateError;
          log.push('auditLog.create');
          if (inTx) attempted.push('auditLog.create');
          return {};
        },
      },
      // 行ロック（SELECT ... FOR UPDATE）。読み取りなので書き込みログには積まない。
      $queryRaw: jest.fn(async () => [{ id: EXPENSE_ID }]),
      $executeRaw: write('executeRaw(submit)', 1),
    };
  };

  const prisma = {
    ...makeClient(committed, false),
    $transaction: jest.fn(async (cb: (tx: FakeClient) => Promise<unknown>) => {
      const pending: string[] = [];
      const tx = makeClient(pending, true);
      txs.push(tx);
      const result = await cb(tx); // 例外ならここで抜け、pending は破棄（ロールバック）
      committed.push(...pending); // 成功時だけコミット
      return result;
    }),
  };
  return { prisma, committed, attempted, txs };
}

type Fake = ReturnType<typeof createFake>;

interface Operation {
  name: string;
  businessWrites: string[]; // この操作が tx 内で行うべき業務の書き込み
  fake: (o?: FakeOptions) => Fake;
  // 実行する。prisma と auditLog は差し替え済みのものを受け取る。
  run: (prisma: Fake['prisma'], auditLog: AuditLogService) => Promise<unknown>;
}

const operations: Operation[] = [
  {
    name: 'ExpensesService.create（申請の作成）',
    businessWrites: ['expenseRequest.create'],
    fake: (o) => createFake({ ...o }),
    run: (prisma, auditLog) =>
      new ExpensesService(prisma as never, auditLog).create(
        USER_ID,
        {
          expenseDate: '2026-11-20',
          amount: 1500,
          category: ExpenseCategory.TRANSPORTATION,
          description: 'テスト',
        },
        IP,
      ),
  },
  {
    name: 'ExpensesService.update（申請の編集）',
    businessWrites: ['expenseRequest.updateMany'],
    fake: (o) => createFake({ expenseStatus: ExpenseStatus.DRAFT, ...o }),
    run: (prisma, auditLog) =>
      new ExpensesService(prisma as never, auditLog).update(
        USER_ID,
        EXPENSE_ID,
        {
          expenseDate: '2026-11-21',
          amount: 2000,
          category: ExpenseCategory.TRANSPORTATION,
          description: '編集後',
        },
        IP,
      ),
  },
  {
    name: 'ExpensesService.remove（申請の削除）',
    businessWrites: ['expenseRequest.deleteMany'],
    fake: (o) => createFake({ expenseStatus: ExpenseStatus.DRAFT, ...o }),
    run: (prisma, auditLog) =>
      new ExpensesService(prisma as never, auditLog).remove(
        USER_ID,
        EXPENSE_ID,
        IP,
      ),
  },
  {
    name: 'ExpensesService.submit（申請の提出）',
    businessWrites: ['executeRaw(submit)'],
    fake: (o) =>
      createFake({
        expenseStatus: ExpenseStatus.DRAFT,
        userRow: { managerId: OTHER_ID, manager: { isActive: true } },
        ...o,
      }),
    run: (prisma, auditLog) =>
      new ExpensesService(prisma as never, auditLog).submit(
        USER_ID,
        EXPENSE_ID,
        IP,
      ),
  },
  {
    name: 'ApprovalsService.approve（承認）',
    businessWrites: ['expenseRequest.updateMany'],
    fake: (o) => createFake({ expenseStatus: ExpenseStatus.SUBMITTED, ...o }),
    run: (prisma, auditLog) =>
      new ApprovalsService(prisma as never, auditLog).approve(
        USER_ID,
        EXPENSE_ID,
        IP,
      ),
  },
  {
    name: 'ApprovalsService.returnRequest（差し戻し）',
    businessWrites: ['expenseRequest.updateMany'],
    fake: (o) => createFake({ expenseStatus: ExpenseStatus.SUBMITTED, ...o }),
    run: (prisma, auditLog) =>
      new ApprovalsService(prisma as never, auditLog).returnRequest(
        USER_ID,
        EXPENSE_ID,
        '領収書を添付してください',
        IP,
      ),
  },
  {
    name: 'RolesService.grantRole（ロール付与）',
    businessWrites: ['userRole.createMany'],
    fake: (o) => createFake({ userRow: { id: OTHER_ID }, ...o }),
    run: (prisma, auditLog) =>
      new RolesService(prisma as never, auditLog).grantRole(
        USER_ID,
        OTHER_ID,
        ROLE_ID,
        IP,
      ),
  },
  {
    name: 'RolesService.revokeRole（ロール剥奪）',
    businessWrites: ['userRole.deleteMany'],
    fake: (o) => createFake({ userRow: { id: OTHER_ID }, ...o }),
    run: (prisma, auditLog) =>
      new RolesService(prisma as never, auditLog).revokeRole(
        USER_ID,
        OTHER_ID,
        ROLE_ID,
        IP,
      ),
  },
  {
    name: 'AuthService.logout（ログアウト＝セッション失効）',
    businessWrites: ['session.updateMany'],
    fake: (o) => createFake({ ...o }),
    run: (prisma, auditLog) =>
      new AuthService(
        prisma as never,
        new SessionsService(prisma as never),
        auditLog,
      ).logout({ id: USER_ID, sessionId: SESSION_ID }, IP),
  },
];

describe('監査ログ：記録に失敗したら業務の更新も反映されない（同一トランザクション）', () => {
  // ログイン成功は argon2 の実ハッシュが要るため別枠（operations に動的に追加）。
  let loginOperation: Operation;

  beforeAll(async () => {
    const hash = await argon2.hash('Correct-Passw0rd-Zq81');
    loginOperation = {
      name: 'AuthService.login（ログイン成功＝失敗カウントのリセット＋セッション作成）',
      businessWrites: ['user.update', 'session.create'],
      fake: (o) =>
        createFake({
          ...o,
          userRow: {
            id: USER_ID,
            email: 'login@example.test',
            name: 'ログイン太郎',
            passwordHash: hash,
            isActive: true,
            lockedUntil: null,
            failedLoginCount: 2,
            managerId: null,
          },
        }),
      run: (prisma, auditLog) =>
        new AuthService(
          prisma as never,
          new SessionsService(prisma as never),
          auditLog,
        ).login('login@example.test', 'Correct-Passw0rd-Zq81', {
          ipAddress: IP,
          userAgent: 'jest',
        }),
    };
  });

  const allOperations = (): Operation[] => [...operations, loginOperation];

  // it.each の表は定義時に評価されるため、ログインを含めるために describe 内で
  // 実行時に全件を回す。
  it('対照：記録が成功すれば、すべての操作で業務の書き込みがコミットされ、記録も同じTxに入る', async () => {
    for (const op of allOperations()) {
      const fake = op.fake();
      const auditLog = new AuditLogService();
      const record = jest
        .spyOn(auditLog, 'record')
        .mockImplementation(async (tx) => {
          (tx as unknown as FakeClient).__log.push('audit.record');
        });

      await op.run(fake.prisma, auditLog);

      // 業務の書き込みと記録の両方がコミットされている。
      for (const w of op.businessWrites) {
        expect({ op: op.name, committed: fake.committed }).toEqual({
          op: op.name,
          committed: expect.arrayContaining([w]),
        });
      }
      expect({ op: op.name, committed: fake.committed }).toEqual({
        op: op.name,
        committed: expect.arrayContaining(['audit.record']),
      });
      expect(record).toHaveBeenCalledTimes(1);
    }
  });

  describe.each([
    ['record が例外を投げる', true],
    ['実物の record 内の DB書き込み（auditLog.create）が失敗する', false],
  ])('記録の失敗の再現方法：%s', (_label, mockRecord) => {
    it('すべての操作で、例外が呼び出し元に伝わり、業務の書き込みはコミットされない（ロールバック）', async () => {
      for (const op of allOperations()) {
        const fake = op.fake(
          mockRecord ? {} : { auditCreateError: new Error('db write failed') },
        );
        const auditLog = new AuditLogService();
        const recordSpy = mockRecord
          ? jest
              .spyOn(auditLog, 'record')
              .mockRejectedValue(new Error('audit record failed'))
          : jest.spyOn(auditLog, 'record'); // 実物を通す（呼び出しだけ観測）

        await expect(op.run(fake.prisma, auditLog)).rejects.toThrow();

        // (1) 空振りでない：業務の書き込みは tx 内で実行されている（その後に記録が失敗した）。
        for (const w of op.businessWrites) {
          expect({ op: op.name, attempted: fake.attempted }).toEqual({
            op: op.name,
            attempted: expect.arrayContaining([w]),
          });
        }
        // (2) ロールバック：コミットされた書き込みは1件も無い。
        expect({ op: op.name, committed: fake.committed }).toEqual({
          op: op.name,
          committed: [],
        });
        // (3) 記録は業務更新と同じ tx で呼ばれた（Txの外ではない）。
        expect(fake.prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(recordSpy).toHaveBeenCalledTimes(1);
        expect(recordSpy.mock.calls[0][0]).toBe(fake.txs[0]);
      }
    });
  });
});
