import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const rows = await sql`
  SELECT id, channel_id, user_id, status, created_at
  FROM tickets
  WHERE status NOT IN ('closed', 'rejected')
  ORDER BY created_at DESC
`;
console.log(rows);
