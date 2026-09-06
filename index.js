import { createClient } from '@supabase/supabase-js';

const TFL_APP_KEY = process.env.TFL_APP_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const GOOD_SERVICE_SEVERITY = 10;
const MODES = 'tube,dlr,overground,elizabeth-line';
const GOOD_CHECKS_TO_CLOSE = 2; // require 2 consecutive good checks (~10 min) before closing

const LONDON_LAT = 51.5074;
const LONDON_LON = -0.1278;

const WEATHER_CODES = {
  0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

function cleanStationName(rawName) {
  return rawName
    .replace(/\s*(Underground|DLR|Rail)?\s*Station$/i, '')
    .trim();
}

async function getStationNamesForLine(lineId) {
  const res = await fetch(`https://api.tfl.gov.uk/Line/${lineId}/StopPoints?app_key=${TFL_APP_KEY}`);
  if (!res.ok) {
    console.error('StopPoints fetch error for', lineId, res.status, await res.text());
    return [];
  }
  const stopPoints = await res.json();
  const names = stopPoints
    .map((sp) => cleanStationName(sp.commonName || ''))
    .filter((name) => name.length > 2);

  return [...new Set(names)].sort((a, b) => b.length - a.length);
}

function findMentionedStations(reasonText, stationNames) {
  if (!reasonText) return [];
  const found = [];
  for (const name of stationNames) {
    if (reasonText.includes(name)) {
      found.push(name);
    }
  }
  return found;
}

async function getCurrentWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LONDON_LAT}&longitude=${LONDON_LON}&current=temperature_2m,precipitation,wind_speed_10m,weather_code`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Weather fetch error', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const c = data.current;
    return {
      temp_c: c.temperature_2m,
      precipitation_mm: c.precipitation,
      wind_kph: c.wind_speed_10m,
      condition: WEATHER_CODES[c.weather_code] || `Code ${c.weather_code}`,
    };
  } catch (err) {
    console.error('Weather fetch exception', err);
    return null;
  }
}

async function run() {
  const res = await fetch(`https://api.tfl.gov.uk/Line/Mode/${MODES}/Status?app_key=${TFL_APP_KEY}`);
  if (!res.ok) {
    console.error('TfL API error', res.status, await res.text());
    return;
  }
  const lines = await res.json();

  for (const line of lines) {
    const lineName = line.name;
    const lineId = line.id;
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
        const stationNames = await getStationNamesForLine(lineId);
        const mentionedStations = findMentionedStations(worst.reason, stationNames);
        const weather = await getCurrentWeather();

        const { error: insertErr } = await supabase.from('delays').insert({
          line: lineName,
          severity: worst.statusSeverity,
          status_description: worst.statusSeverityDescription,
          reason: worst.reason || null,
          category: worst.disruption?.category || null,
          tfl_last_updated: worst.disruption?.lastUpdate || null,
          mentioned_stations: mentionedStations,
          peak_severity: worst.statusSeverity,
          peak_status_description: worst.statusSeverityDescription,
          peak_reason: worst.reason || null,
          good_streak: 0,
          weather_temp_c: weather?.temp_c ?? null,
          weather_precipitation_mm: weather?.precipitation_mm ?? null,
          weather_wind_kph: weather?.wind_kph ?? null,
          weather_condition: weather?.condition ?? null,
          raw: worst,
          started_at: new Date().toISOString(),
        });
        if (insertErr) console.error('Insert error for', lineName, insertErr);
        else console.log(`New delay logged: ${lineName} - ${worst.statusSeverityDescription} (stations: ${mentionedStations.join(', ') || 'none found'}) (weather: ${weather?.condition || 'unknown'})`);
      } else {
        const isWorse = worst.statusSeverity < ongoingRecord.peak_severity;
        const { error: updateErr } = await supabase
          .from('delays')
          .update({
            severity: worst.statusSeverity,
            status_description: worst.statusSeverityDescription,
            reason: worst.reason || null,
            good_streak: 0,
            ...(isWorse && {
              peak_severity: worst.statusSeverity,
              peak_status_description: worst.statusSeverityDescription,
              peak_reason: worst.reason || null,
            }),
          })
          .eq('id', ongoingRecord.id);

        if (updateErr) console.error('Update error for', lineName, updateErr);
        else if (isWorse) console.log(`Delay escalated: ${lineName} - now ${worst.statusSeverityDescription}`);
      }
    } else {
      if (ongoingRecord) {
        const newStreak = (ongoingRecord.good_streak || 0) + 1;

        if (newStreak >= GOOD_CHECKS_TO_CLOSE) {
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
          else console.log(`Delay resolved: ${lineName} - lasted ${durationMinutes} min (peak: ${ongoingRecord.peak_status_description})`);
        } else {
          const { error: streakErr } = await supabase
            .from('delays')
            .update({ good_streak: newStreak })
            .eq('id', ongoingRecord.id);

          if (streakErr) console.error('Streak update error for', lineName, streakErr);
          else console.log(`${lineName} showing Good Service (${newStreak}/${GOOD_CHECKS_TO_CLOSE} checks) - not yet closing`);
        }
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
