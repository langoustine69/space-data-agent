import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';

const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

const agent = await createAgent({
  name: 'space-data-agent',
  version: '1.0.0',
  description: 'Aggregated space data from NASA and Open-Notify. Get astronomy pictures, astronaut info, asteroid tracking, ISS location, and comprehensive space briefings.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER: Fetch JSON with error handling ===
async function fetchJSON(url: string, timeout = 30000): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
  } catch (e: any) {
    clearTimeout(timeoutId);
    throw new Error(`Fetch failed: ${e.message}`);
  }
}

// === FREE ENDPOINT: Space Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of current space activity - astronauts in space and daily astronomy picture title',
  input: z.object({}),
  handler: async () => {
    const [astros, apod] = await Promise.all([
      fetchJSON('http://api.open-notify.org/astros.json'),
      fetchJSON(`https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}`)
    ]);
    
    return {
      output: {
        humansInSpace: astros.number,
        crafts: [...new Set(astros.people.map((p: any) => p.craft))],
        todaysApod: apod.title,
        apodDate: apod.date,
        fetchedAt: new Date().toISOString(),
        dataSources: ['NASA APOD', 'Open-Notify Astros']
      }
    };
  },
});

// === PAID ENDPOINT 1 ($0.001): Astronomy Picture of the Day ===
addEntrypoint({
  key: 'apod',
  description: 'NASA Astronomy Picture of the Day with full details, explanation, and media URL',
  input: z.object({
    date: z.string().optional().describe('Date in YYYY-MM-DD format (defaults to today)')
  }),
  price: "$0.001",
  handler: async (ctx) => {
    const dateParam = ctx.input.date ? `&date=${ctx.input.date}` : '';
    const data = await fetchJSON(`https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}${dateParam}`);
    
    return {
      output: {
        title: data.title,
        date: data.date,
        explanation: data.explanation,
        mediaType: data.media_type,
        url: data.url,
        hdUrl: data.hdurl || null,
        copyright: data.copyright || 'Public Domain',
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 2 ($0.001): Astronauts in Space ===
addEntrypoint({
  key: 'astronauts',
  description: 'Current humans in space, grouped by spacecraft (ISS, Tiangong, etc.)',
  input: z.object({}),
  price: "$0.001",
  handler: async () => {
    const data = await fetchJSON('http://api.open-notify.org/astros.json');
    
    // Group by craft
    const byCraft: Record<string, string[]> = {};
    for (const person of data.people) {
      if (!byCraft[person.craft]) byCraft[person.craft] = [];
      byCraft[person.craft].push(person.name);
    }
    
    return {
      output: {
        totalInSpace: data.number,
        byCraft,
        crafts: Object.keys(byCraft),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 3 ($0.002): Near-Earth Asteroids ===
addEntrypoint({
  key: 'asteroids',
  description: 'Near-Earth objects (asteroids) approaching Earth within date range',
  input: z.object({
    startDate: z.string().optional().describe('Start date YYYY-MM-DD (defaults to today)'),
    endDate: z.string().optional().describe('End date YYYY-MM-DD (defaults to start + 3 days)')
  }),
  price: "$0.002",
  handler: async (ctx) => {
    const today = new Date().toISOString().split('T')[0];
    const start = ctx.input.startDate || today;
    
    // Default end date is start + 3 days (API limit is 7 days)
    let end = ctx.input.endDate;
    if (!end) {
      const endDate = new Date(start);
      endDate.setDate(endDate.getDate() + 3);
      end = endDate.toISOString().split('T')[0];
    }
    
    const data = await fetchJSON(
      `https://api.nasa.gov/neo/rest/v1/feed?start_date=${start}&end_date=${end}&api_key=${NASA_API_KEY}`
    );
    
    // Flatten and sort by closest approach
    const asteroids: any[] = [];
    for (const [date, neos] of Object.entries(data.near_earth_objects)) {
      for (const neo of neos as any[]) {
        const approach = neo.close_approach_data[0];
        asteroids.push({
          name: neo.name,
          id: neo.id,
          diameter_km: {
            min: neo.estimated_diameter.kilometers.estimated_diameter_min,
            max: neo.estimated_diameter.kilometers.estimated_diameter_max
          },
          isPotentiallyHazardous: neo.is_potentially_hazardous_asteroid,
          approachDate: approach?.close_approach_date,
          missDistance_km: approach ? parseFloat(approach.miss_distance.kilometers) : null,
          relativeVelocity_kph: approach ? parseFloat(approach.relative_velocity.kilometers_per_hour) : null
        });
      }
    }
    
    asteroids.sort((a, b) => (a.missDistance_km || Infinity) - (b.missDistance_km || Infinity));
    
    return {
      output: {
        totalCount: data.element_count,
        dateRange: { start, end },
        hazardousCount: asteroids.filter(a => a.isPotentiallyHazardous).length,
        closestApproach: asteroids[0] || null,
        asteroids: asteroids.slice(0, 20),
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 4 ($0.001): ISS Location ===
addEntrypoint({
  key: 'iss',
  description: 'Current International Space Station location (latitude/longitude)',
  input: z.object({}),
  price: "$0.001",
  handler: async () => {
    const data = await fetchJSON('http://api.open-notify.org/iss-now.json', 15000);
    
    return {
      output: {
        latitude: parseFloat(data.iss_position.latitude),
        longitude: parseFloat(data.iss_position.longitude),
        timestamp: data.timestamp,
        fetchedAt: new Date().toISOString()
      }
    };
  },
});

// === PAID ENDPOINT 5 ($0.005): Full Space Report ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive space briefing: APOD, astronauts, asteroids, and ISS location in one call',
  input: z.object({
    includeAsteroids: z.boolean().optional().default(true).describe('Include near-Earth objects (adds latency)')
  }),
  price: "$0.005",
  handler: async (ctx) => {
    const today = new Date().toISOString().split('T')[0];
    
    const promises: Promise<any>[] = [
      fetchJSON(`https://api.nasa.gov/planetary/apod?api_key=${NASA_API_KEY}`),
      fetchJSON('http://api.open-notify.org/astros.json'),
      fetchJSON('http://api.open-notify.org/iss-now.json', 15000).catch(() => null)
    ];
    
    if (ctx.input.includeAsteroids) {
      const endDate = new Date();
      endDate.setDate(endDate.getDate() + 3);
      promises.push(
        fetchJSON(`https://api.nasa.gov/neo/rest/v1/feed?start_date=${today}&end_date=${endDate.toISOString().split('T')[0]}&api_key=${NASA_API_KEY}`)
      );
    }
    
    const [apod, astros, iss, neo] = await Promise.all(promises);
    
    // Group astronauts by craft
    const byCraft: Record<string, string[]> = {};
    for (const person of astros.people) {
      if (!byCraft[person.craft]) byCraft[person.craft] = [];
      byCraft[person.craft].push(person.name);
    }
    
    // Process asteroids if included
    let asteroidSummary = null;
    if (neo) {
      const hazardous: any[] = [];
      for (const neos of Object.values(neo.near_earth_objects) as any[][]) {
        for (const a of neos) {
          if (a.is_potentially_hazardous_asteroid) {
            hazardous.push({
              name: a.name,
              diameter_km_max: a.estimated_diameter.kilometers.estimated_diameter_max,
              approachDate: a.close_approach_data[0]?.close_approach_date
            });
          }
        }
      }
      asteroidSummary = {
        totalTracked: neo.element_count,
        hazardousObjects: hazardous.length,
        hazardousList: hazardous.slice(0, 5)
      };
    }
    
    return {
      output: {
        report: {
          date: today,
          astronomyPictureOfTheDay: {
            title: apod.title,
            explanation: apod.explanation.substring(0, 500) + '...',
            url: apod.url,
            mediaType: apod.media_type
          },
          humansInSpace: {
            total: astros.number,
            byCraft
          },
          issLocation: iss ? {
            latitude: parseFloat(iss.iss_position.latitude),
            longitude: parseFloat(iss.iss_position.longitude)
          } : 'unavailable',
          nearEarthObjects: asteroidSummary
        },
        fetchedAt: new Date().toISOString(),
        dataSources: ['NASA APOD', 'NASA NEO', 'Open-Notify']
      }
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms')
  }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return {
      output: {
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      }
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) return { output: { transactions: [] } };
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

// === SERVE ICON ===
app.get('/icon.png', async (c) => {
  if (existsSync('./icon.png')) {
    const icon = readFileSync('./icon.png');
    return new Response(icon, { headers: { 'Content-Type': 'image/png' } });
  }
  return c.text('No icon', 404);
});

// === ERC-8004 REGISTRATION FILE ===
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.AGENT_URL || 'https://space-data-agent-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "space-data-agent",
    description: "Aggregated space data from NASA and Open-Notify. Astronomy pictures, astronaut tracking, asteroid monitoring, ISS location. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Space Data Agent running on port ${port}`);

export default { port, fetch: app.fetch };
