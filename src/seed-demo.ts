import { loadConfig, ConfigError } from './config.ts';
import { getDb, closeDb } from './db.ts';
import { applyMigrations } from './migrate.ts';
import { hashPassword } from './security/password.ts';
import { createApplication, changeStatus } from './services/applications.ts';
import { getFormForPosition, validateAnswers } from './services/forms.ts';
import { createPosition } from './services/positions.ts';
import { setPermissions } from './services/permissions.ts';
import { registerApplicant, authenticate } from './services/auth.ts';
import { Sessions } from './security/session.ts';

/**
 * LOCAL DEVELOPMENT / PREVIEW DEMO SEED — never run on a production VPS.
 *
 * Guards:
 *  - refuses to run when NODE_ENV=production
 *  - refuses to run when a super owner already exists
 *  - requires DEMO_SEED=1 in the environment
 *
 * It creates real accounts and one real application (submitted through the
 * same service layer the website uses) so every dashboard has genuine data.
 */

const DEMO_USERS = {
  owner: { username: 'tanveer', email: 'tanveer@top-cloud.local', display_name: 'Tanveer', password: 'Owner-Demo-2026!' },
  admin: { username: 'admin.demo', email: 'admin@top-cloud.local', display_name: 'Demo Admin', password: 'Admin-Demo-2026!' },
  reviewer: { username: 'reviewer.demo', email: 'reviewer@top-cloud.local', display_name: 'Demo Reviewer', password: 'Reviewer-Demo-2026!' },
  applicant: { username: 'sam.applicant', email: 'sam@top-cloud.local', display_name: 'Sam Rivera', password: 'Applicant-Demo-2026!' },
};

function main(): void {
  if (process.env.NODE_ENV === 'production') {
    console.error('REFUSED: seed-demo will not run in production.');
    process.exit(1);
  }
  if (process.env.DEMO_SEED !== '1') {
    console.error('REFUSED: set DEMO_SEED=1 to run the demo seed (development only).');
    process.exit(1);
  }
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`ERROR: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
  const db = getDb(cfg);
  try {
    applyMigrations();
    if (db.prepare('SELECT id FROM users WHERE is_super = 1').get()) {
      console.log('REFUSED: a super owner already exists in this database.');
      process.exit(1);
    }
    const sessions = new Sessions({ db, secret: cfg.sessionSecret });

    const ins = db.prepare(
      "INSERT INTO users (username, email, password_hash, display_name, role, is_super, active) VALUES (?,?,?,?,?,?,1)",
    );
    ins.run(DEMO_USERS.owner.username, DEMO_USERS.owner.email, hashPassword(DEMO_USERS.owner.password), DEMO_USERS.owner.display_name, 'owner', 1);
    const ownerId = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    const insR = db.prepare(
      "INSERT INTO users (username, email, password_hash, display_name, role, is_super, active) VALUES (?,?,?,?,?,0,1)",
    );
    insR.run(DEMO_USERS.admin.username, DEMO_USERS.admin.email, hashPassword(DEMO_USERS.admin.password), DEMO_USERS.admin.display_name, 'admin');
    const adminId = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);
    insR.run(DEMO_USERS.reviewer.username, DEMO_USERS.reviewer.email, hashPassword(DEMO_USERS.reviewer.password), DEMO_USERS.reviewer.display_name, 'reviewer');
    const reviewerId = Number((db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id);

    // Grant the demo admin staff management + settings so the UI is fully explorable.
    const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(ownerId) as never;
    const admin = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId) as never;
    setPermissions(db, owner as never, admin as never, { 'staff.manage': true, 'settings.manage': true });

    const applicant = registerApplicant(db, sessions, {
      username: DEMO_USERS.applicant.username,
      email: DEMO_USERS.applicant.email,
      display_name: DEMO_USERS.applicant.display_name,
      password: DEMO_USERS.applicant.password,
      ip: '127.0.0.1',
    });

    const p1 = createPosition(db, {
      title: 'Cloud Support Specialist',
      department: 'Support',
      summary: 'First-line technical support for our cloud hosting customers.',
      description:
        'You will help customers with server setup, DNS, backups and general troubleshooting. You do not need to be a sysadmin, but you must be patient, honest and quick to learn.\n\nWhat a typical week looks like:\n- Answering tickets and chat messages\n- Writing short how-to answers\n- Escalating gnarly problems with good context',
      eligibility:
        '- Age 18+\n- Reliable English communication\n- Basic understanding of hosting concepts (IP, DNS, SSH)\n- Available at least 15 hours/week',
      open: true,
    });
    const p2 = createPosition(db, {
      title: 'Community Moderator',
      department: 'Community',
      summary: 'Keep the community safe, welcoming and on-topic.',
      description:
        'You will moderate our community channels, enforce the rules fairly, welcome new members and flag content that needs staff attention.\n\nGreat moderators are calm under pressure and write clear, friendly explanations.',
      eligibility: '- Age 18+\n- Experience moderating a community (preferred)\n- Calm, fair and consistent\n- Available at least 10 hours/week',
      open: true,
    });
    const p3 = createPosition(db, {
      title: 'Billing & Account Manager',
      department: 'Operations',
      summary: 'Handle invoices, refunds and account changes accurately.',
      description: 'You will manage billing tickets, process refunds per policy and keep account records clean.',
      eligibility: '- Age 18+\n- Attention to detail\n- Available at least 10 hours/week',
      open: false,
    });

    // A genuine application submitted through the real service layer.
    const form = getFormForPosition(db, p1);
    const validation = validateAnswers(form.fields, {
      full_name: 'Sam Rivera',
      contact: 'sam@example.com',
      motivation: 'I have been supporting friends and family with their home servers for years and I want to do this professionally. I enjoy writing clear answers and I stay calm when customers are frustrated.',
      experience: 'Some',
      available_hours: '16–30',
      availability_wkends: 'yes',
    });
    const { application } = createApplication(db, {
      applicant: applicant.user!,
      positionId: p1,
      form,
      validation,
      ip: '127.0.0.1',
    });
    if (application) {
      const reviewer = db.prepare('SELECT * FROM users WHERE id = ?').get(reviewerId) as never;
      changeStatus(db, reviewer, application.id, 'reviewing', 'Assigned for first pass.', '127.0.0.1');
      db.prepare('UPDATE applications SET reviewer_id = ? WHERE id = ?').run(reviewerId, application.id);
    }

    console.log('Demo seed complete.');
    console.log('Login accounts (development preview only):');
    for (const [k, u] of Object.entries(DEMO_USERS)) {
      console.log(`  ${k.padEnd(9)} ${u.username.padEnd(16)} ${u.password}`);
    }
  } finally {
    closeDb();
  }
}

main();
