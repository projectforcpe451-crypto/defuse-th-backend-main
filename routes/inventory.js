const express = require('express');
const router = express.Router();

const CS2_APP_ID = 730;
const CS2_CONTEXT_ID = 2;

// ─────────────────────────────
// ✅ CACHE (มี expire)
// ─────────────────────────────
const priceCache = new Map();
const CACHE_TTL = 60 * 1000; // 1 นาที

const fetchPrice = async (marketHashName) => {
  try {
    const url = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(marketHashName)}`;

    const res = await fetch(url);
    const data = await res.json();

    if (data.success) {
      return parseFloat(
        data.median_price?.replace(/[^0-9.]/g, '') || "0"
      );
    }
  } catch (err) {
    // ❌ ตัด log ทิ้งเพื่อลด spam
  }

  return 0;
};

const fetchPriceCached = async (name) => {
  const cached = priceCache.get(name);

  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.price;
  }

  const price = await fetchPrice(name);

  priceCache.set(name, {
    price,
    time: Date.now(),
  });

  return price;
};

// ─────────────────────────────
// CONFIG
// ─────────────────────────────
const MAX_PRICE_ITEMS = 20; // 🔥 จำกัดจำนวน item ที่ดึงราคา

// ─────────────────────────────
// STATIC MAP
// ─────────────────────────────
const RARITY_COLORS = {
  'Consumer Grade': '#B0C3D9',
  'Industrial Grade': '#5E98D9',
  'Mil-Spec Grade': '#4B69FF',
  'Restricted': '#8847FF',
  'Classified': '#D32CE6',
  'Covert': '#EB4B4B',
  'Contraband': '#E4AE33',
  'Extraordinary': '#E4AE33',
  'Base Grade': '#B0C3D9',
};

const WEAR_MAP = {
  'Factory New': 'FN',
  'Minimal Wear': 'MW',
  'Field-Tested': 'FT',
  'Well-Worn': 'WW',
  'Battle-Scarred': 'BS',
};

// ─────────────────────────────
// PARSE ITEM
// ─────────────────────────────
const parseItem = (asset, description) => {
  if (!description) return null;

  const tags = description.tags || [];
  const getTag = (cat) =>
    tags.find(t => t.category === cat)?.localized_tag_name || null;

  const rarity = getTag('Rarity') || 'Base Grade';
  const wear = getTag('Exterior');
  const type = getTag('Weapon') || getTag('Type') || 'Unknown';
  const name = description.market_hash_name || description.name || 'Unknown';

  const parts = name.split(' | ');
  const weapon = parts[0]?.replace('StatTrak™ ', '').replace('Souvenir ', '').trim() || name;
  const skinRaw = parts[1] || '';
  const skin = skinRaw.replace(/\s*\(.*\)/, '').trim() || name;

  const isStatTrak = name.includes('StatTrak™');
  const isSouvenir = name.includes('Souvenir');

  const imageUrl = description.icon_url
    ? `https://community.cloudflare.steamstatic.com/economy/image/${description.icon_url}/360fx360f`
    : null;

  let category = 'Guns';
  if (name.includes('Gloves') || name.includes('Wraps')) category = 'Glove';
  else if (['Knife','Karambit','Bayonet','Butterfly','Falchion','Flip','Gut ','Huntsman','M9 ','Navaja','Shadow','Stiletto','Talon','Ursus'].some(k => name.includes(k))) category = 'Knife';
  else if (['Case','Capsule','Package','Sticker','Graffiti','Patch','Music Kit'].some(k => name.includes(k))) category = 'Cases';

  return {
    id: asset.assetid,
    assetId: asset.assetid,
    classId: asset.classid,

    name,
    marketHashName: description.market_hash_name,

    weapon,
    skin,
    rarity,
    rarityColor: RARITY_COLORS[rarity] || '#B0C3D9',

    wear: wear || null,
    wearShort: wear ? (WEAR_MAP[wear] || wear) : null,

    price: 0,
    priceUSD: 0,
    float: null,

    image: imageUrl,
    category,
    type,

    tradeLock: description.tradable === 0,
    marketable: description.marketable === 1,
    inInventory: true,

    stattrak: isStatTrak,
    souvenir: isSouvenir,
    tags,
  };
};

// ─────────────────────────────
// GET INVENTORY
// ─────────────────────────────
router.get('/:steamId', async (req, res) => {
  const { steamId } = req.params;
  const count = req.query.count || 100;

  if (!steamId || steamId.length < 10) {
    return res.status(400).json({ error: 'Invalid SteamID' });
  }

  const url = `https://steamcommunity.com/inventory/${steamId}/${CS2_APP_ID}/${CS2_CONTEXT_ID}?l=english&count=${count}`;

  try {
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Steam API error` });
    }

    const data = await response.json();

    if (!data.assets || !data.descriptions) {
      return res.json({ items: [], total: 0 });
    }

    const descMap = {};
    data.descriptions.forEach(d => { descMap[d.classid] = d; });

    let items = data.assets
      .map(asset => parseItem(asset, descMap[asset.classid]))
      .filter(Boolean);

    // 🔥 จำกัดจำนวน item ที่ดึงราคา
    const priceTargets = items.slice(0, MAX_PRICE_ITEMS);

    // 🔥 ยิงราคาแบบ parallel (เร็วกว่า delay)
    await Promise.all(
      priceTargets.map(async (item) => {
        const priceUSD = await fetchPriceCached(item.marketHashName);
        item.priceUSD = priceUSD;
        item.price = Math.round(priceUSD * 35);
      })
    );

    res.json({
      success: true,
      steamId,
      total: data.total_inventory_count || items.length,
      items,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────
// GET PRICE (ใช้หน้า detail)
// ─────────────────────────────
router.get('/price/:marketHashName', async (req, res) => {
  const name = decodeURIComponent(req.params.marketHashName);

  const priceUSD = await fetchPriceCached(name);

  res.json({
    success: true,
    name,
    usd: priceUSD,
    thb: Math.round(priceUSD * 35),
  });
});

module.exports = router;
