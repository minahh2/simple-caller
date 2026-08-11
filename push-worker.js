import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import webPush from 'web-push';

// Configuration
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
// Note: You must provide a SUPABASE_SERVICE_ROLE_KEY in your .env for the worker to bypass RLS
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const VAPID_PUBLIC = process.env.VITE_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing Supabase credentials.");
  process.exit(1);
}

if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.error("Missing VAPID keys. Ensure VITE_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set.");
  process.exit(1);
}

webPush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC, VAPID_PRIVATE);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

console.log("Push Notification Worker Started.");
console.log(`Polling Supabase at ${SUPABASE_URL} every 30 seconds...`);

async function checkAndSendPush() {
  try {
    // Find all distinct venues that have a 'pending' call created more than 15 seconds ago
    const fifteenSecondsAgo = new Date(Date.now() - 15 * 1000).toISOString();

    const { data: calls, error: callsError } = await supabase
      .from('service_calls')
      .select('venue_id, id, created_at')
      .eq('status', 'pending')
      .lte('created_at', fifteenSecondsAgo);

    if (callsError) throw callsError;
    if (!calls || calls.length === 0) return;

    // Get unique venue IDs that have pending calls
    const uniqueVenues = [...new Set(calls.map(c => c.venue_id))];

    // For each venue, get their push subscriptions and send a notification
    for (const venueId of uniqueVenues) {
      const pendingCount = calls.filter(c => c.venue_id === venueId).length;
      
      const { data: subscriptions, error: subError } = await supabase
        .from('push_subscriptions')
        .select('*')
        .eq('venue_id', venueId);

      if (subError) {
        console.error(`Error fetching subscriptions for venue ${venueId}:`, subError);
        continue;
      }

      if (!subscriptions || subscriptions.length === 0) continue;

      const payload = JSON.stringify({
        title: "Unacknowledged Calls",
        body: `You have ${pendingCount} unacknowledged call(s) waiting.`,
        url: "/#/staff"
      });

      console.log(`Sending ${subscriptions.length} push notifications for venue ${venueId} (${pendingCount} pending calls)...`);

      const promises = subscriptions.map(async (sub) => {
        try {
          await webPush.sendNotification({
            endpoint: sub.endpoint,
            keys: {
              p256dh: sub.p256dh,
              auth: sub.auth
            }
          }, payload);
        } catch (e) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            console.log(`Subscription expired/invalid for endpoint: ${sub.endpoint}. Deleting from DB.`);
            await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
          } else {
            console.error('Error sending push:', e);
          }
        }
      });

      await Promise.allSettled(promises);
    }
  } catch (error) {
    console.error("Error in checkAndSendPush:", error);
  }
}

// Run every 30 seconds
setInterval(checkAndSendPush, 30000);

// Run once immediately
checkAndSendPush();

// --- Dummy HTTP Server for Coolify Health Checks ---
// Coolify requires a port to be exposed. We spin up a tiny server to satisfy it.
import http from 'http';

const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Push Notification Worker is running!\n');
});

server.listen(PORT, () => {
  console.log(`Dummy HTTP server listening on port ${PORT} for Coolify health checks.`);
});
