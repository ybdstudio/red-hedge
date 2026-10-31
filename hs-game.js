/*! hs-game.js 3.0.0 — the HS TikTok SDK for native TikTok mini games.
 *
 * Put this file and hs-tiktok-sdk.min.js next to your game.js, then:
 *
 *   var HSGame = require('./hs-game.js');
 *   HSGame.start({
 *     gameId: '...', sdkKey: 'sk_live_...',
 *     defaults: { rewards: {...}, items: {...} },     // the game's own reward table
 *     onGive: function (items, from) { ... },         // THE place anything is given
 *     onLoad: function (cloud) { ... }                // cloud save from another phone
 *   });
 *
 *   HSGame.claim('mission_a')        // a game moment completed → its reward goes to onGive
 *   HSGame.showAd('revive')          // ad at a place → reward (if any) goes to onGive
 *   HSGame.share({ title })          // share → the "share" reward goes to onGive
 *   HSGame.save(progress)            // cloud save
 *   HSGame.shop() / HSGame.buy(id)   // purchases → onGive
 *
 * Data-driven: a reward key, an ad place, an item, a product — if it is in the
 * HS dashboard (or the game's defaults), it works; if not, nothing happens.
 *
 * Rules this file enforces so a game cannot get them wrong:
 *   - It never throws, and runs without the SDK or credentials (rewards then
 *     come from the defaults; ads, shop and cloud are simply off).
 *   - Rewards reach the game ONLY through onGive. If onGive throws, nothing is
 *     recorded: a claim can be made again, a paid order comes back next login.
 *   - An ad reward only for a completed ad; a share reward only for a share.
 *   - A fresh install never overwrites the cloud.
 *
 * Needs hs-tiktok-sdk 1.0.7 or newer.
 */
(function (root) {
  'use strict';

  var VERSION = '3.0.0';
  var AD_STALE_MS = 90000;       // the SDK waits for TikTok's own answer; never latch an ad forever
  var TIKTOK_KEYS = { tiktok_shortcut: 'shortcut', tiktok_profile: 'profile' };
  var BUILTIN_LIMIT = { share: 'daily', tiktok_shortcut: 'once', tiktok_profile: 'once' };

  var sdk = null;
  var loadError = '';
  try {
    sdk = (typeof require === 'function') ? require('./hs-tiktok-sdk.min.js') : null;
  } catch (e) {
    loadError = 'hs-tiktok-sdk.min.js not found next to hs-game.js';
  }
  if (!sdk && root && root.HSTikTokSDK) sdk = root.HSTikTokSDK;

  var started = false;
  var ready = false;             // the SDK initialised (credentials set)
  var loginDone = false;         // the startup login finished, either way
  var giveCb = null;
  var loadCb = null;
  var defaults = { rewards: {}, items: {} };
  var cloudSettled = false;
  var cloudData = null;
  var loadDelivered = false;
  var latest;
  var hasLatest = false;
  var adBusySince = 0;
  var trace = [];

  var has = function (o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); };
  var log = function (msg) { try { if (HSGame.debug) console.log('[HSGame] ' + msg); } catch (e) {} };
  var note = function (what) { if (trace.length < 500) trace.push(what); };
  var noteOnce = function (what) { if (trace.indexOf(what) < 0) note(what); };
  var safe = function (fn, fallback) { try { return fn(); } catch (e) { log('error: ' + (e && e.message)); return fallback; } };
  var copy = function (v) { return safe(function () { return JSON.parse(JSON.stringify(v)); }, v); };

  // ─── The reward table: dashboard (iaa_config) over the game's defaults ────

  function remote(section) {
    var cfg = sdk && ready ? safe(function () { return sdk.ads.config; }, null) : null;
    var s = cfg && cfg[section];
    return s && typeof s === 'object' ? s : null;
  }

  /**
   * { items: { hint: 2 }, limit } for a key, or null when it gives nothing.
   * The dashboard wins per key — including `"key": null`, which switches a
   * default reward off. Accepts the old list form [{ type, amount }] too.
   */
  function entry(key) {
    var r = remote('rewards');
    var d = has(defaults.rewards, key) ? defaults.rewards[key] : undefined;
    var raw = has(r, key) ? r[key] : d;
    if (raw === undefined || raw === null || typeof raw !== 'object') return null;
    // The limit is part of what the moment IS: a dashboard entry that only
    // changes the amount keeps the game's own limit — a "once" never becomes
    // "every time" because someone retyped the number.
    var limit = limitOf(raw);
    if (!limit) limit = limitOf(d);
    if (!limit) limit = BUILTIN_LIMIT[key] || 'always';
    return { items: toItems(raw), limit: limit };
  }

  function limitOf(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
    var l = raw.$limit !== undefined ? raw.$limit : raw.limit;   // `limit` = the 2.x shape
    return l === 'once' || l === 'daily' || l === 'always' ? l : '';
  }

  /**
   * { hint: 2, coins: 50 } from any form: that map itself (keys starting with
   * "$" are settings, not items; true counts as 1), the older list
   * [{ type, amount, value }] products may still carry, or the 2.x shape
   * { rewards: [...], limit }. Zero and negative amounts are dropped.
   */
  function toItems(raw) {
    var items = {};
    if (raw && !Array.isArray(raw) && typeof raw === 'object' && Array.isArray(raw.rewards)) raw = raw.rewards;
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        var x = raw[i];
        var n0 = x ? (Number(x.amount) || (x.value === true ? 1 : 0)) : 0;
        if (x && typeof x.type === 'string' && x.type && n0 > 0) items[x.type] = (items[x.type] || 0) + n0;
      }
    } else if (raw && typeof raw === 'object') {
      for (var k in raw) {
        if (!has(raw, k) || k.charAt(0) === '$') continue;
        var n = raw[k] === true ? 1 : Number(raw[k]);
        if (n > 0) items[k] = n;
      }
    }
    return items;
  }

  function isEmpty(o) { for (var k in o) if (has(o, k)) return false; return true; }

  function catalog() {
    var out = {};
    var d = defaults.items || {};
    var r = remote('items') || {};
    for (var a in d) if (has(d, a)) out[a] = d[a];
    for (var b in r) if (has(r, b)) { if (r[b] === null) delete out[b]; else out[b] = r[b]; }
    return out;
  }

  /** Hands items to the game. True when onGive ran without throwing. */
  function give(items, from) {
    note('give:' + from);
    if (!giveCb) { log('nothing given for "' + from + '" — HSGame.start({ onGive }) is not set'); return false; }
    var cat = null;
    for (var id in items) {
      if (!has(items, id)) continue;
      if (!cat) cat = catalog();
      if (!isEmpty(cat) && !has(cat, id)) log('item "' + id + '" (from ' + from + ') is not in the items catalog');
    }
    try { giveCb(copy(items), from); return true; }
    catch (e) { log('onGive threw for "' + from + '": ' + (e && e.message) + ' — not recorded'); return false; }
  }

  // ─── Claims: once / daily / always ────────────────────────────────────────
  // In TikTok storage, and inside the cloud save (`_hs`) when the game uses
  // save(), so a reinstall or a new phone does not pay again. `daily` follows
  // the phone's date — never use it for paid value.

  var CLAIMS_KEY = 'hsgame.claims';
  var memClaims = {};

  function today() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function loadClaims() {
    var t = root && root.tt;
    var raw = t && typeof t.getStorageSync === 'function' ? safe(function () { return t.getStorageSync(CLAIMS_KEY); }, '') : '';
    if (!raw) return memClaims;
    var parsed = safe(function () { return typeof raw === 'string' ? JSON.parse(raw) : raw; }, null);
    return parsed && typeof parsed === 'object' ? parsed : memClaims;
  }

  function storeClaims(c) {
    memClaims = c;
    var t = root && root.tt;
    if (t && typeof t.setStorageSync === 'function') safe(function () { t.setStorageSync(CLAIMS_KEY, JSON.stringify(c)); });
    if (cloudSettled && hasLatest) cloud.isDirtyForCloud = true;
  }

  function mergeClaims(other) {
    if (!other || typeof other !== 'object') return;
    var c = loadClaims();
    for (var k in other) {
      if (!has(other, k) || !other[k]) continue;
      var mine = c[k], theirs = other[k];
      if (!mine) { c[k] = theirs; continue; }
      c[k] = { n: Math.max(mine.n || 0, theirs.n || 0), last: (mine.last || '') > (theirs.last || '') ? mine.last : theirs.last };
    }
    storeClaims(c);
  }

  function isClaimed(key, limit) {
    var e = loadClaims()[key];
    if (!e || limit === 'always') return false;
    return limit === 'daily' ? e.last === today() : true;
  }

  function recordClaim(key) {
    var c = loadClaims();
    var e = c[key] || { n: 0, last: '' };
    c[key] = { n: (e.n || 0) + 1, last: today() };
    storeClaims(c);
  }

  /** The common path: the key's reward, if any and if its limit allows, given and recorded. */
  function payout(key, from) {
    var e = entry(key);
    if (!e || isEmpty(e.items) || isClaimed(key, e.limit)) return null;
    if (!give(e.items, from || key)) return null;
    recordClaim(key);
    return copy(e.items);
  }

  // ─── Cloud save ───────────────────────────────────────────────────────────

  var cloud = {
    isDirtyForCloud: false,
    serializeForCloud: function () {
      if (!hasLatest) return {};
      var out = {};
      for (var k in latest) if (has(latest, k)) out[k] = latest[k];
      var c = loadClaims();
      if (!isEmpty(c)) out._hs = { claims: c };
      return out;
    },
    onCloudDataReceived: function (json) {
      // Only the first login of a session counts: a later re-login must not
      // hand an older cloud copy to the game mid-play.
      if (cloudSettled) { log('ignoring cloud data from a later login'); return; }
      var data = safe(function () { return JSON.parse(json); }, null);
      if (data && typeof data === 'object' && data._hs) { mergeClaims(data._hs.claims); delete data._hs; }
      if (data && typeof data === 'object' && !isEmpty(data)) {
        // The pre-login save is the fresh-install state: drop it, never upload
        // it. Until the game saves its merge, the cloud copy IS the save — so
        // claims recorded meanwhile still travel with it.
        latest = copy(data); hasLatest = true;
        cloudData = data;
        deliverLoad();
      }
      // settleCloud() runs on loginSuccess, after this, for every login path.
    }
  };

  function settleCloud() {
    if (cloudSettled) return;
    cloudSettled = true;
    if (hasLatest) cloud.isDirtyForCloud = true;
  }

  function deliverLoad() {
    if (loadDelivered || !cloudData || !loadCb) return;
    loadDelivered = true;
    note('onLoad');
    var data = cloudData;
    safe(function () { loadCb(data); });
  }

  // ─── Purchases: one route, the same onGive ────────────────────────────────

  var lastBuyGiven = null;   // whether the order of the buy() in progress reached the game

  function onOrder(o) {
    note('order:' + o.product_id);
    var items = toItems(o.rewards);
    var ok = false;
    try {
      // Throwing is the "not taken" signal: the SDK does not confirm the order,
      // so the next login delivers it again. A paid order is stricter than a
      // claim: nothing to give, or an item this build's catalog does not know,
      // is kept rather than "given" to a game that would silently ignore it.
      if (!giveCb) throw new Error('onGive is not set — order kept for the next login');
      if (isEmpty(items)) throw new Error('product ' + o.product_id + ' gives no item — order kept');
      var cat = catalog();
      for (var id in items) {
        if (has(items, id) && !isEmpty(cat) && !has(cat, id)) throw new Error('item "' + id + '" is not in the catalog — order kept');
      }
      if (!give(items, 'product:' + o.product_id)) throw new Error('onGive did not take product ' + o.product_id);
      ok = true;
    } finally {
      if (!o.recovered) lastBuyGiven = ok;
    }
  }

  // ─── TikTok APIs the backend is not involved in (missions, share) ─────────

  function tiktok(name) {
    var g = root && root.TTMinis && root.TTMinis.game;
    if (g && typeof g[name] === 'function') {
      var can = typeof g.canIUse !== 'function' || safe(function () { return g.canIUse(name); }, false);
      if (can) return g;
    }
    var t = root && root.tt;
    return t && typeof t[name] === 'function' ? t : null;
  }

  /**
   * Calls a callback-style TikTok API. Resolves { ok, res, err }; never
   * rejects, and never hangs: a host that answers nothing (backgrounded
   * mid-call) resolves 'timeout' after `ms`, and a late answer is dropped.
   */
  function callTikTok(name, args, ms) {
    return new Promise(function (resolve) {
      var settled = false;
      var done = function (r) { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
      var timer = setTimeout(function () { done({ ok: false, err: 'timeout' }); }, ms || 15000);
      var host = tiktok(name);
      if (!host) return done({ ok: false, err: 'unsupported' });
      var o = {};
      for (var k in (args || {})) o[k] = args[k];
      o.success = function (res) { done({ ok: true, res: res }); };
      o.fail = function (e) { done({ ok: false, err: (e && (e.errMsg || e.message)) || 'failed' }); };
      try { host[name](o); } catch (e) { done({ ok: false, err: String(e && e.message || e) }); }
    });
  }

  // ─── TikTok missions: tiktok_shortcut / tiktok_profile ────────────────────
  // The player is sent off with tiktokMission.start(); the reward is paid
  // when TikTok later confirms it (opened from the icon / came in from the
  // profile) — checked after login and on every return to the app.

  var MISSIONS = {
    shortcut: { start: 'addShortcut', check: 'getShortcutMissionReward' },
    profile: { start: 'startEntranceMission', check: 'getEntranceMissionReward' }
  };
  var missionBusy = {};
  var missionGiven = {};
  var missionStarted = {};   // the player was sent off this session
  var showHooked = false;

  function checkMission(kind) {
    var key = 'tiktok_' + kind;
    if (ready && !loginDone) return Promise.resolve(false);   // wait for the dashboard's values and the cloud claims
    var e = entry(key);
    if (!giveCb || !e || isEmpty(e.items) || missionBusy[kind] || missionGiven[kind] || isClaimed(key, e.limit)) return Promise.resolve(false);
    missionBusy[kind] = true;
    return callTikTok(MISSIONS[kind].check, null, 10000).then(function (r) {
      missionBusy[kind] = false;
      if (!r.ok) return false;
      var res = r.res || {};
      var flag = res.canReceiveReward !== undefined ? res.canReceiveReward : res.can_receive_reward;
      // An explicit `true` pays. Some TikTok builds answer success with no
      // flag at all — that counts only after the player was actually sent
      // off this session (what the SDK's own missions rely on), never at a
      // cold start, where it would pay a mission nobody did.
      var can = flag === true || (flag === undefined && !!missionStarted[kind]);
      if (!can) return false;
      if (missionGiven[kind] || isClaimed(key, e.limit)) return false;
      // Locked for the session before the game runs, so a game that gives and
      // then throws in its UI code is not paid on every return to the app;
      // persisted only when onGive did not throw.
      missionGiven[kind] = true;
      if (!give(e.items, key)) return false;
      recordClaim(key);
      return true;
    });
  }

  function checkMissions() {
    return Promise.all([checkMission('shortcut'), checkMission('profile')]).then(function () {});
  }

  function hookShow() {
    if (showHooked) return;
    var t = root && root.tt;
    if (t && typeof t.onShow === 'function') { showHooked = true; safe(function () { t.onShow(function () { checkMissions(); }); }); }
  }

  // ─── Ads ──────────────────────────────────────────────────────────────────

  var adLabels = {};    // places the game asked showAd / canShowAd about this session
  var shareKeys = { share: true };

  function adConfigured(label) {
    if (!sdk || !ready || !label) return false;
    var ads = sdk.ads;
    return safe(function () { return !!ads.getPlacement(label) && ads.resolvePlace(label).resolved; }, false);
  }

  /** An ad place: one the dashboard has, or one the game shows ads at. Its reward is showAd's to pay. */
  function isAdPlace(key) {
    if (has(adLabels, key)) return true;
    return !!(sdk && ready && safe(function () { return sdk.ads.getPlacement(key); }, null));
  }

  /** The place gives a reward with a once / daily limit, and it is used up. */
  function rewardUsedUp(label) {
    var e = entry(label);
    return !!(e && !isEmpty(e.items) && e.limit !== 'always' && isClaimed(label, e.limit));
  }

  var HSGame = {
    version: VERSION,
    debug: false,
    /** Why the last showAd() gave null: 'not configured', 'skipped', 'busy', or TikTok's message. */
    lastAdError: '',
    /** Why the last share() gave null: 'unsupported', 'claimed' (shared, reward already taken), or TikTok's message. */
    lastShareError: '',

    get ready() { return ready; },
    get loggedIn() { return !!(sdk && ready && sdk.isAuthenticated); },
    get openId() { return sdk && ready ? sdk.openId : null; },
    /** The raw HSTikTokSDK, for anything this file does not wrap. */
    get sdk() { return ready ? sdk : null; },
    get trace() { return trace.slice(); },
    /** The defaults passed to start() — read by hs-check. */
    get defaults() { return copy(defaults); },
    /** True when start() received an onGive. */
    get canGive() { return !!giveCb; },

    /**
     * hs-check only (inert unless the checker set __HS_CHECK__): would onGive
     * accept this key's reward? Hands the items over without recording a claim.
     */
    _probe: function (key) {
      if (!(root && root.__HS_CHECK__)) return null;
      var e = entry(String(key || ''));
      if (!e || isEmpty(e.items)) return { empty: true };
      return { items: copy(e.items), given: give(e.items, 'hs-check:' + key) };
    },

    /**
     * Start everything. Call once at startup. Resolves { loggedIn, reason };
     * never rejects. Rewards work from `defaults` even before (and without) login.
     */
    start: function (opts) {
      opts = opts || {};
      note('start');
      if (started) return Promise.resolve({ loggedIn: HSGame.loggedIn, reason: 'already started' });
      started = true;
      HSGame.debug = !!opts.debug;
      if (typeof opts.onGive === 'function') giveCb = opts.onGive;
      if (typeof opts.onLoad === 'function') loadCb = opts.onLoad;
      var d = opts.defaults || {};
      defaults = {
        rewards: d.rewards && typeof d.rewards === 'object' ? copy(d.rewards) : {},
        items: d.items && typeof d.items === 'object' ? copy(d.items) : {}
      };
      if (!giveCb) log('start() without onGive — nothing can be given');
      hookShow();

      var check = root && root.__HS_CHECK__;   // stand-in credentials for hs-check only
      var gameId = String(opts.gameId || (check && check.gameId) || '');
      var sdkKey = String(opts.sdkKey || (check && check.sdkKey) || '');

      var offline = function (reason) { loginDone = true; checkMissions(); return Promise.resolve({ loggedIn: false, reason: reason }); };
      if (!sdk) return offline(loadError || 'SDK not loaded');
      if (!gameId || !sdkKey) return offline('gameId / sdkKey not set');

      var ok = safe(function () {
        if (!sdk.init({ gameId: gameId, sdkKey: sdkKey, enableDebugLogs: HSGame.debug })) return false;
        sdk.registerSyncProvider(cloud);
        sdk.registerRewardHandler({ onOrderRewardsDelivered: onOrder });
        // The cloud is settled by a SUCCESSFUL login only — the startup one or
        // a later one (a buy() after a failed start). The SDK hands the cloud
        // copy over right after this event, so settle on the next tick. A failed
        // login settles nothing: a fresh install must not upload its empty
        // state, and the real cloud copy must still be read when login works.
        sdk.on('loginSuccess', function () { setTimeout(settleCloud, 0); });
        return true;
      }, false);
      if (!ok) return offline('init failed — check gameId / sdkKey');
      ready = true;

      var finish = function (r) {
        if (r.loggedIn) settleCloud();
        loginDone = true;
        checkMissions();
        return r;
      };
      return sdk.auth.login().then(function (r) {
        if (!r.success) log('login failed: ' + r.failure + ' ' + (r.error || ''));
        return finish({ loggedIn: !!r.success, reason: r.success ? '' : (r.failure + ': ' + (r.error || '')) });
      }, function (e) {
        return finish({ loggedIn: false, reason: String(e && e.message || e) });
      });
    },

    // ─── Rewards ─────────────────────────────────────────────

    /**
     * A game moment completed (a mission, a quest, a daily gift, a level
     * bonus…). Its reward — the dashboard's, else the default — goes to
     * onGive. Returns the items given (to show a message), or null: not
     * configured, nothing in it, already claimed (once / today), or onGive threw.
     */
    claim: function (key) {
      key = String(key || '');
      note('claim:' + key);
      if (has(TIKTOK_KEYS, key)) { log('claim("' + key + '") refused — TikTok missions pay themselves when TikTok confirms'); return null; }
      // An ad place's reward is paid by showAd, the share reward by share():
      // claiming them here would pay without the ad / share, or pay twice.
      if (isAdPlace(key) || has(shareKeys, key)) { log('claim("' + key + '") refused — it is paid by ' + (has(shareKeys, key) ? 'share()' : 'showAd()')); return null; }
      // Before login lands, the cloud's claim record (a reinstall) and the
      // dashboard's values are not here yet — a "once" could pay twice.
      if (ready && !loginDone) { log('claim("' + key + '") refused — call it after HSGame.start() resolves'); return null; }
      return payout(key);
    },

    /** The items a key would give — for labels like "Reward: 2 hints". Null when it gives nothing. */
    rewards: function (key) {
      noteOnce('rewards:' + key);
      var e = entry(String(key || ''));
      return e && !isEmpty(e.items) ? copy(e.items) : null;
    },

    /** True when claim(key) would give something now — for "!" badges and enabled buttons. */
    available: function (key) {
      key = String(key || '');
      noteOnce('available:' + key);
      var e = entry(key);
      if (!e || isEmpty(e.items)) return false;
      if (ready && !loginDone) return false;
      if (has(TIKTOK_KEYS, key)) return HSGame.tiktokMission.supported(TIKTOK_KEYS[key]) && !missionGiven[TIKTOK_KEYS[key]] && !isClaimed(key, e.limit);
      return !isClaimed(key, e.limit);
    },

    /** The item catalog entry: { category, name, icon, ... } — dashboard over defaults. */
    item: function (id) { var c = catalog(); return has(c, id) ? copy(c[id]) : null; },
    /** Every item: { id: { category, name, ... } }. */
    items: function () { return copy(catalog()); },

    // ─── Ads ─────────────────────────────────────────────────

    /** True when an ad is set up for this place right now — show / hide the button with it, every time it is drawn. */
    canShowAd: function (label) {
      noteOnce('canShowAd:' + label);
      adLabels[label] = true;
      if (adBusySince && Date.now() - adBusySince < AD_STALE_MS) return false;
      if (rewardUsedUp(label)) return false;   // a once / daily ad reward already taken: do not offer the ad
      return adConfigured(label);
    },

    /**
     * Show the ad set up for this place in the dashboard. Resolves:
     *   null — no ad here (not configured, cooling down, no fill), or closed early
     *   {}   — the ad completed and this place gives no reward (e.g. interstitial)
     *   { hint: 1 } — completed, and the reward went to onGive
     * The game never needs to know whether the place is rewarded or interstitial.
     */
    showAd: function (label) {
      label = String(label || '');
      note('showAd:' + label);
      adLabels[label] = true;
      HSGame.lastAdError = '';
      if (adBusySince && Date.now() - adBusySince < AD_STALE_MS) { HSGame.lastAdError = 'busy'; return Promise.resolve(null); }
      if (!sdk || !ready) { HSGame.lastAdError = 'not configured'; return Promise.resolve(null); }
      // Never make a player watch an ad whose reward they already took.
      if (rewardUsedUp(label)) { HSGame.lastAdError = 'claimed'; return Promise.resolve(null); }
      // Before any config arrived (no login), let the SDK fetch it; otherwise
      // a place the dashboard does not have is simply "no ad".
      var loaded = safe(function () { return sdk.ads.isConfigLoaded; }, false);
      if (loaded && !adConfigured(label)) {
        HSGame.lastAdError = safe(function () { return sdk.ads.getPlacement(label); }, null) ? 'cooling down' : 'not configured';
        return Promise.resolve(null);
      }
      adBusySince = Date.now();
      return sdk.ads.showAdsRemote(label).then(function (r) {
        adBusySince = 0;
        if (!r || !r.success) { HSGame.lastAdError = (r && r.error_message) || 'unavailable'; return null; }
        if (!r.completed) { HSGame.lastAdError = 'skipped'; return null; }
        var e = entry(label);
        if (!e || isEmpty(e.items)) return {};         // e.g. an interstitial: shown, nothing to give
        var got = payout(label);
        // A rewarded ad that completed but gave nothing (onGive threw) must not
        // look like the no-reward {} — the game would continue as if paid.
        if (!got) { HSGame.lastAdError = 'not given'; return null; }
        return got;
      }, function (e) {
        adBusySince = 0;
        HSGame.lastAdError = String(e && e.message || e);
        return null;
      });
    },

    // ─── Share ───────────────────────────────────────────────

    /** True when this TikTok can share (needs TikTok 40.3.0+). */
    canShare: function () { return !!tiktok('shareAppMessage'); },

    /**
     * Open TikTok's share sheet: opts { title, subtitle, imageUrl, templateType }.
     * When TikTok reports it done, the reward of `key` (default "share", once a
     * day) goes to onGive. Resolves the items given, or null (cancelled,
     * unsupported, or already claimed — see lastShareError).
     */
    share: function (opts, key) {
      key = String(key || 'share');
      note('share:' + key);
      shareKeys[key] = true;
      HSGame.lastShareError = '';
      // The player picks friends in TikTok's sheet: give it time, but not forever.
      return callTikTok('shareAppMessage', opts || {}, 120000).then(function (r) {
        if (!r.ok) { HSGame.lastShareError = r.err; return null; }
        var items = payout(key);
        if (!items) HSGame.lastShareError = 'claimed';
        return items;
      });
    },

    // ─── TikTok missions ─────────────────────────────────────

    tiktokMission: {
      /** "shortcut" (add to home screen) or "profile" (visit from the TikTok profile). */
      supported: function (kind) { var m = MISSIONS[kind]; return !!(m && tiktok(m.start)); },
      /** Already rewarded — remove the "!" badge. */
      done: function (kind) {
        var key = 'tiktok_' + kind;
        var e = entry(key);
        return !!missionGiven[kind] || isClaimed(key, e ? e.limit : 'once');
      },
      /** Button tap: send the player to do it. Resolves 'started' | 'unsupported' | 'failed'. */
      start: function (kind) {
        note('tiktokMission:' + kind);
        var m = MISSIONS[kind];
        if (!m) return Promise.resolve('unsupported');
        return callTikTok(m.start, null, 120000).then(function (r) {
          if (r.ok) { missionStarted[kind] = true; checkMissions(); }
          return r.ok ? 'started' : (r.err === 'unsupported' ? 'unsupported' : 'failed');
        });
      },
      /** Ask TikTok now (also done after login and on every return to the app). */
      refresh: function () { return checkMissions(); }
    },

    // ─── Shop ────────────────────────────────────────────────

    /**
     * Products from the HS dashboard: [{ product_id, name, description,
     * beans_cost, items: { hint: 15 }, ...display fields (icon, badge…) }].
     * Works before login.
     */
    shop: function () {
      note('shop');
      if (!sdk || !ready) return Promise.resolve([]);
      return sdk.iap.getShopItems().then(function (r) {
        if (!r.success) return [];
        return (r.data || []).map(function (p) {
          var out = {};
          for (var k in p) if (has(p, k) && k !== 'rewards') out[k] = p[k];
          out.items = toItems(p.rewards);
          return out;
        });
      }, function () { return []; });
    },

    /**
     * Buy a product. Resolves { ok, error, delivered }. The items arrive in
     * onGive — never give them here. ok + !delivered: paid, but this build
     * could not give it (unknown item, onGive threw) — it is kept and comes
     * back at the next start; tell the player it is on its way.
     */
    buy: function (productId) {
      note('buy');
      if (!sdk || !ready) return Promise.resolve({ ok: false, error: 'Store unavailable', delivered: false });
      lastBuyGiven = null;
      return sdk.iap.buyProduct(String(productId)).then(
        function (r) {
          var ok = !!r.success;
          return { ok: ok, error: ok ? '' : (r.error || 'Purchase failed'), delivered: ok && lastBuyGiven !== false };
        },
        function (e) { return { ok: false, error: String(e && e.message || e), delivered: false }; }
      );
    },

    // ─── Cloud save ──────────────────────────────────────────

    /** Save progress: the WHOLE small progress object, every time it changes. */
    save: function (data) {
      note('save');
      var c = safe(function () { return JSON.parse(JSON.stringify(data)); }, undefined);
      if (c === undefined || c === null || typeof c !== 'object') { log('save() needs a plain JSON object'); return; }
      latest = c; hasLatest = true;
      if (cloudSettled) cloud.isDirtyForCloud = true;
    }
  };

  if (typeof module === 'object' && module && module.exports) module.exports = HSGame;
  if (root) root.HSGame = HSGame;
})(typeof GameGlobal !== 'undefined' ? GameGlobal : (typeof globalThis !== 'undefined' ? globalThis : this));
