import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const result = await sql`
  UPDATE tickets
  SET status = 'closed', closed_at = NOW()
  WHERE status NOT IN ('closed', 'rejected')
    AND (
      channel_id LIKE 'pending:%'
      OR channel_id = '1506915040169693326'
    )
  RETURNING id, channel_id, user_id
`;
console.log('Closed:', result);
