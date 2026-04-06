import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../services/firebase';
import admin from '../services/firebase';
import { requireAdmin } from '../middleware/auth';
import { fetchPhotosFromSheet } from '../services/sheets';
import { Participant } from '../types';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// POST /admin/events
// Body: { name: string; votingCode: string; participants: Participant[] }
adminRouter.post('/events', async (req, res) => {
  const { name, votingCode, participants } = req.body as {
    name?: string;
    votingCode?: string;
    participants?: Participant[];
  };

  if (!name || !votingCode || !Array.isArray(participants) || participants.length === 0) {
    res.status(400).json({ error: 'name, votingCode, and participants[] are required' });
    return;
  }

  try {
    // Reject duplicate voting codes across all events
    const dupSnap = await db.collection('events').where('votingCode', '==', votingCode).limit(1).get();
    if (!dupSnap.empty) {
      res.status(409).json({ error: `Voting code "${votingCode}" is already used by another event` });
      return;
    }

    const eventRef = db.collection('events').doc();

    const batch = db.batch();

    batch.set(eventRef, {
      name,
      votingCode,
      isOpen: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    for (const p of participants) {
      const docRef = eventRef.collection('participants').doc();
      batch.set(docRef, {
        fullName: p.fullName,
        nickname: p.nickname,
        group: p.group,
        phone: p.phone,
        phoneNormalized: p.phone.replace(/\D/g, ''),
      });
    }

    await batch.commit();

    res.status(201).json({ id: eventRef.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/events
adminRouter.get('/events', async (_req, res) => {
  try {
    const snap = await db.collection('events').orderBy('createdAt', 'desc').get();
    const events = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /admin/events/:id
adminRouter.delete('/events/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const eventRef = db.collection('events').doc(id);
    const snap = await eventRef.get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    // Delete all subcollections
    const subcollections = ['participants', 'photos', 'votes'];
    for (const sub of subcollections) {
      const subSnap = await eventRef.collection(sub).get();
      const batch = db.batch();
      subSnap.docs.forEach((doc) => batch.delete(doc.ref));
      if (!subSnap.empty) await batch.commit();
    }

    await eventRef.delete();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH /admin/events/:id
// Body: { isOpen?: boolean; votingCode?: string }
adminRouter.patch('/events/:id', async (req, res) => {
  const { id } = req.params;
  const { isOpen, votingCode } = req.body as { isOpen?: boolean; votingCode?: string };

  const update: Record<string, unknown> = {};
  if (typeof isOpen === 'boolean') update.isOpen = isOpen;
  if (votingCode) update.votingCode = votingCode;

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  try {
    const eventRef = db.collection('events').doc(id);
    const snap = await eventRef.get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (votingCode) {
      const dupSnap = await db.collection('events').where('votingCode', '==', votingCode).limit(1).get();
      if (!dupSnap.empty && dupSnap.docs[0].id !== id) {
        res.status(409).json({ error: `Voting code "${votingCode}" is already used by another event` });
        return;
      }
    }

    await eventRef.update(update);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/events/:id/sync-photos
// Body: { sheetUrl: string }
// Fetches photos from Google Sheet and upserts into Firestore.
adminRouter.post('/events/:id/sync-photos', async (req, res) => {
  const { id } = req.params;
  const { sheetUrl } = req.body as { sheetUrl?: string };

  if (!sheetUrl) {
    res.status(400).json({ error: 'sheetUrl is required' });
    return;
  }

  try {
    const eventRef = db.collection('events').doc(id);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const photos = await fetchPhotosFromSheet(sheetUrl);

    const batch = db.batch();
    // Clear existing photos first
    const existing = await eventRef.collection('photos').get();
    existing.docs.forEach((doc) => batch.delete(doc.ref));

    for (const photo of photos) {
      const photoRef = eventRef.collection('photos').doc();
      batch.set(photoRef, { ...photo, voteCount: 0 });
    }

    await batch.commit();

    res.json({ synced: photos.length });
  } catch (err: unknown) {
    if (err instanceof Error) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /admin/events/:id/results
// Returns all photos sorted by voteCount desc, top 3 flagged.
adminRouter.get('/events/:id/results', async (req, res) => {
  const { id } = req.params;

  try {
    const eventRef = db.collection('events').doc(id);
    const eventSnap = await eventRef.get();
    if (!eventSnap.exists) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const photosSnap = await eventRef
      .collection('photos')
      .orderBy('voteCount', 'desc')
      .get();

    const photos: Array<Record<string, unknown>> = [];
    let rank = 1;
    for (let i = 0; i < photosSnap.docs.length; i++) {
      const doc = photosSnap.docs[i];
      const data = doc.data();
      if (i > 0 && data.voteCount < (photosSnap.docs[i - 1].data().voteCount as number)) {
        rank = i + 1;
      }
      photos.push({ id: doc.id, ...data, rank, isTop3: rank <= 3 });
    }

    const totalVotes = photos.reduce((sum, p) => sum + ((p.voteCount as number) || 0), 0);

    res.json({ photos, totalVotes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Admin management ──────────────────────────────────────────────────────────

// GET /admin/admins
adminRouter.get('/admins', async (_req, res) => {
  try {
    const snap = await db.collection('admins').get();
    const admins = snap.docs.map((doc) => ({ username: doc.id, createdAt: doc.data().createdAt }));
    res.json(admins);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /admin/admins
// Body: { username: string; password: string }
adminRouter.post('/admins', async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };

  if (!username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }
  if (password.length < 8) {
    res.status(400).json({ error: 'Password must be at least 8 characters' });
    return;
  }

  try {
    const existing = await db.collection('admins').doc(username).get();
    if (existing.exists) {
      res.status(409).json({ error: 'Admin already exists' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db.collection('admins').doc(username).set({
      username,
      passwordHash,
      createdAt: new Date().toISOString(),
    });

    res.status(201).json({ username });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /admin/admins/:username
adminRouter.delete('/admins/:username', async (req, res) => {
  const { username } = req.params;
  const requestingAdmin = (res.locals as { username: string }).username;

  if (username === requestingAdmin) {
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }

  try {
    const snap = await db.collection('admins').doc(username).get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Admin not found' });
      return;
    }

    // Prevent deleting the last admin
    const countSnap = await db.collection('admins').count().get();
    if (countSnap.data().count <= 1) {
      res.status(400).json({ error: 'Cannot delete the last admin account' });
      return;
    }

    await db.collection('admins').doc(username).delete();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
