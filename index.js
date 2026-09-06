import { createClient } from '@supabase/supabase-js';

const TFL_APP_KEY = process.env.TFL_APP_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const GOOD_SERVICE_SEVERITY = 10;

async function run() {
  const res = await fetch(`https://api.tfl.gov.uk/Line/Mode/tube,dlr,overground,elizabeth-line/Status?app_key=${TFL_APP_KEY}`);
  if (!res.ok) {
    console.error('TfL API error', res.status, await res.text());
    return;
  }
  const lines = await res.json();

  for (const line of lines) {
    const lineName = line.name;
    const statuses = line.lineStatuses || [];
    if (statuses.length === 0) continue;

    const worst = statuses.reduce((a, b) => (a.statusSeverity < b.statusSeverity ? a : b));
    const isGoodService = worst.statusSeverity >= GOOD_SERVICE_SEVERITY;

    const { data: ongoing, error: fetchErr } = await supabase
      .from('delays')
      .select('*')
      .eq('line', lineName)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1);

    if (fetchErr) {
      console.error('Fetch error for', lineName, fetchErr);
      continue;
    }

    const ongoingRecord = ongoing && ongoing[0];

    if (!isGoodService) {
      if (!ongoingRecord) {
        const { error: insertErr } = await supabase.from('delays').insert({
          line: lineName,
          severity: worst.statusSeverity,
          status_description: worst.statusSeverityDescription,
          reason: worst.reason || null,
          category: worst.disruption?.category || null,
          tfl_last_updated: worst.disruption?.lastUpdate || null,
          raw: worst,
          started_at: new Date().toISOString(),
        });
        if (insertErr) console.error('Insert error for', lineName, insertErr);
        else console.log(`New delay logged: ${lineName} - ${worst.statusSeverityDescription}`);
      }
    } else {
      if (ongoingRecord) {
        const endedAt = new Date();
        const startedAt = new Date(ongoingRecord.started_at);
        const durationMinutes = Math.round((endedAt - startedAt) / 60000);

        const { error: updateErr } = await supabase
          .from('delays')
          .update({
            ended_at: endedAt.toISOString(),
            duration_minutes: durationMinutes,
          })
          .eq('id', ongoingRecord.id);

        if (updateErr) console.error('Update error for', lineName, updateErr);
        else console.log(`Delay resolved: ${lineName} - lasted ${durationMinutes} min`);
      }
    }
  }
}

run()
  .then(() => {
    console.log('Run complete');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Fatal error', err);
    process.exit(1);
  });
