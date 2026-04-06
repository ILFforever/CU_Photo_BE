import { Router } from 'express';
import { db } from '../services/firebase';
import admin from '../services/firebase';

export const voteRouter = Router();

// GET /events/active
// Returns the currently open event, or the most recently created one.
voteRouter.get('/active', async (_req, res) => {
  try {
    // Prefer an open event first
    let snap = await db.collection('events')
      .where('isOpen', '==', true)
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (snap.empty) {
      // Fall back to most recently created
      snap = await db.collection('events')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
    }

    if (snap.empty) {
      res.status(404).json({ error: 'No events found' });
      return;
    }

    const doc = snap.docs[0];
    res.json({ id: doc.id, name: doc.data().name, isOpen: doc.data().isOpen });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /events/verify
// Body: { phone: string; fullName: string; votingCode: string }
// Finds the open event matching the voting code, then verifies the participant.
voteRouter.post('/verify', async (req, res) => {
  const { phone, fullName, votingCode } = req.body as { phone?: string; fullName?: string; votingCode?: string };

  if (!phone || !fullName || !votingCode) {
    res.status(400).json({ error: 'phone, fullName, and votingCode are required' });
    return;
  }

  const normalizedPhone = phone.replace(/\D/g, '');

  try {
    // Find open event matching the voting code
    const eventsSnap = await db.collection('events')
      .where('isOpen', '==', true)
      .where('votingCode', '==', votingCode)
      .limit(1)
      .get();

    if (eventsSnap.empty) {
      // Check if any event has this code but is closed
      const closedSnap = await db.collection('events')
        .where('votingCode', '==', votingCode)
        .limit(1)
        .get();
      if (!closedSnap.empty) {
        res.status(403).json({ error: 'VOTING_CLOSED' });
      } else {
        res.status(404).json({ error: 'รหัสโหวตไม่ถูกต้อง' });
      }
      return;
    }

    const eventDoc = eventsSnap.docs[0];
    const id = eventDoc.id;

    // Find participant by normalized phone
    const participantsSnap = await db
      .collection('events')
      .doc(id)
      .collection('participants')
      .where('phoneNormalized', '==', normalizedPhone)
      .limit(1)
      .get();

    if (participantsSnap.empty) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }

    const participant = participantsSnap.docs[0].data();

    // Loose name match — check if submitted name appears in fullName (handles nickname vs full)
    const submittedName = fullName.trim().toLowerCase();
    const storedFull = participant.fullName.toLowerCase();
    const storedNick = participant.nickname.toLowerCase();

    if (!storedFull.includes(submittedName) && submittedName !== storedNick) {
      res.status(401).json({ error: 'Name does not match our records' });
      return;
    }

    const voteSnap = await db
      .collection('events')
      .doc(id)
      .collection('votes')
      .doc(normalizedPhone)
      .get();

    const votesUsed: number = voteSnap.exists
      ? (voteSnap.data()?.photoIds as string[]).length
      : 0;

    res.json({
      eventId: id,
      fullName: participant.fullName,
      nickname: participant.nickname,
      group: participant.group,
      votesUsed,
      votesAllowed: 2,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /events/:id/photos
voteRouter.get('/:id/photos', async (req, res) => {
  const { id } = req.params;

  try {
    const eventSnap = await db.collection('events').doc(id).get();
    if (!eventSnap.exists) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (!eventSnap.data()?.isOpen) {
      res.status(403).json({ error: 'Voting is not open yet' });
      return;
    }

    const photosSnap = await db
      .collection('events')
      .doc(id)
      .collection('photos')
      .get();

    const photos = photosSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    // Shuffle so order doesn't hint at popularity
    photos.sort(() => Math.random() - 0.5);

    res.json(photos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /events/:id/results  (public — no auth)
voteRouter.get('/:id/results', async (req, res) => {
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

    // Assign tied ranks (same voteCount → same rank)
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

// POST /events/:id/vote
// Body: { phone: string; votingCode: string; photoId: string }
voteRouter.post('/:id/vote', async (req, res) => {
  const { id } = req.params;
  const { phone, votingCode, photoId } = req.body as {
    phone?: string;
    votingCode?: string;
    photoId?: string;
  };

  if (!phone || !votingCode || !photoId) {
    res.status(400).json({ error: 'phone, votingCode, and photoId are required' });
    return;
  }

  const normalizedPhone = phone.replace(/\D/g, '');

  try {
    const eventRef = db.collection('events').doc(id);
    const eventSnap = await eventRef.get();

    if (!eventSnap.exists) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const event = eventSnap.data()!;

    if (!event.isOpen) {
      res.status(403).json({ error: 'Voting is not open' });
      return;
    }

    if (event.votingCode !== votingCode) {
      res.status(401).json({ error: 'Invalid voting code' });
      return;
    }

    // Verify participant exists
    const participantSnap = await eventRef
      .collection('participants')
      .where('phoneNormalized', '==', normalizedPhone)
      .limit(1)
      .get();

    if (participantSnap.empty) {
      res.status(404).json({ error: 'Participant not found' });
      return;
    }

    const participant = participantSnap.docs[0].data();

    // Verify photo exists
    const photoRef = eventRef.collection('photos').doc(photoId);
    const photoSnap = await photoRef.get();
    if (!photoSnap.exists) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    const voteRef = eventRef.collection('votes').doc(normalizedPhone);

    // Use a transaction to prevent race conditions
    await db.runTransaction(async (tx) => {
      const existingVote = await tx.get(voteRef);
      const photoIds: string[] = existingVote.exists
        ? (existingVote.data()?.photoIds as string[])
        : [];

      if (photoIds.length >= 2) {
        throw new Error('VOTES_EXHAUSTED');
      }
      if (photoIds.includes(photoId)) {
        throw new Error('DUPLICATE_PHOTO');
      }

      const newPhotoIds = [...photoIds, photoId];

      tx.set(voteRef, {
        photoIds: newPhotoIds,
        voterName: participant.fullName,
        voterPhone: normalizedPhone,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      tx.update(photoRef, {
        voteCount: admin.firestore.FieldValue.increment(1),
      });
    });

    res.json({ ok: true });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'VOTES_EXHAUSTED') {
      res.status(409).json({ error: 'You have already used all 2 votes' });
      return;
    }
    if (err instanceof Error && err.message === 'DUPLICATE_PHOTO') {
      res.status(409).json({ error: 'You already voted for this photo' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
