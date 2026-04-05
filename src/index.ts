import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { voteRouter } from './routes/vote';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { seedDefaultAdmin } from './services/seedAdmin';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRouter);
app.use('/events', voteRouter);
app.use('/admin', adminRouter);

seedDefaultAdmin().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
