import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { voteRouter } from './routes/vote';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { seedDefaultAdmin } from './services/seedAdmin';

const app = express();
const PORT = process.env.PORT || 3000;

const allowedOrigins = (process.env.ALLOWED_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length
    ? (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) cb(null, true);
        else cb(new Error(`CORS: ${origin} not allowed`));
      }
    : '*',
}));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRouter);
app.use('/events', voteRouter);
app.use('/admin', adminRouter);

seedDefaultAdmin().then(() => {
  app.listen(Number(PORT), '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
});
