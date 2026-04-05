import bcrypt from 'bcryptjs';
import { db } from './firebase';

const DEFAULT_USERNAME = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const DEFAULT_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin1234';

export async function seedDefaultAdmin(): Promise<void> {
  const snap = await db.collection('admins').limit(1).get();
  if (!snap.empty) return; // admins already exist

  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  await db.collection('admins').doc(DEFAULT_USERNAME).set({
    username: DEFAULT_USERNAME,
    passwordHash,
    createdAt: new Date().toISOString(),
  });

  console.log(`Default admin seeded — username: "${DEFAULT_USERNAME}", password: "${DEFAULT_PASSWORD}"`);
  console.log('Change this password immediately via POST /admin/admins.');
}
