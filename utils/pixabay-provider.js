const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STOP = new Set(('that this with from your have will what when they them their about into more than ' +
  'then also just like here there today welcome channel video videos imagine discover hello everyone back ' +
  'were been being these those which while where every some most such only very much many over after before ' +
  'under through scene shot camera text captions subscribe useful comments comment related context share ' +
  'watch helped help follow next more experience experiences learn learning explained official trailer ' +
  'intro introduction outro conclusion ready wondered ever dive lets let your our youre were thats ' +
  'quick fast easy simple great best good new using used make makes made how why powers').split(' '));
const BOILERPLATE = /cinematic[^.]*\.?|clean closing visual[^.]*\.?|no captions or on-screen text\.?/gi;
const PEOPLE = /\b(police|policeman|officer|man|men|woman|women|people|person|boy|boys|girl|girls|face|portrait|selfie|couple|family|child|children|kid|kids|actor|actress|crowd|friends|wedding|model|guy|lady|student|students|team)\b/i;

module.exports = function makePixabayProvider(VideoProvider, normalizeCredentials) {
  return class PixabayProvider extends VideoProvider {
    constructor(credentials, options = {}) {
      const creds = normalizeCredentials(credentials);
      super('pixabay', {
        model: 'pixabay-stock',
        capabilities: { minDuration: 3, maxDuration: 60, defaultResolution: '720p', maxPromptLength: 2000, text: true, firstFrame: true }
      });
      let key = options.apiKey || (creds.pixabay && creds.pixabay.apiKey) || process.env.PIXABAY_API_KEY;
      if (!key) {
        try {
          const file = path.join(__dirname, '..', 'config', 'credentials.json');
          key = (JSON.parse(fs.readFileSync(file, 'utf8')).pixabay || {}).apiKey;
        } catch (_e) { /* key nahi mili */ }
      }
      this.apiKey = key || null;
      this.used = new Set();
    }

    isAvailable() { return Boolean(this.apiKey); }

    keywords(prompt) {
      const cleaned = String(prompt || '').replace(BOILERPLATE, ' ');
      const words = (cleaned.toLowerCase().match(/[a-z]{4,}/g) || []).filter(w => !STOP.has(w));
      return [...new Set(words)].slice(0, 3);
    }

    pickUrl(hit) {
      const v = hit.videos || {};
      for (const k of ['medium', 'large', 'small', 'tiny']) if (v[k] && v[k].url) return v[k].url;
      return null;
    }

    async search(q) {
      const params = { key: this.apiKey, q: q.slice(0, 100), per_page: 30, safesearch: 'true', video_type: 'film' };
      if (process.env.PIXABAY_CATEGORY) params.category = process.env.PIXABAY_CATEGORY;
      const res = await axios.get('https://pixabay.com/api/videos/', { params, timeout: 20000 });
      return (res.data && res.data.hits) || [];
    }

    async createTask(input) {
      const request = this.normalizeRequest(input);
      const words = this.keywords(request.prompt);
      const hint = process.env.PIXABAY_QUERY_HINT || 'technology';
      const allowPeople = process.env.PIXABAY_ALLOW_PEOPLE === '1';
      const tries = [];
      if (/\b(AI|artificial intelligence|machine learning|chatgpt|automation)\b/i.test(String(request.prompt || ''))) tries.push('artificial intelligence');
      if (words.length >= 2) tries.push(words.slice(0, 2).join(' '));
      if (words.length >= 1) tries.push(words[0]);
      tries.push(hint, 'abstract');
      for (const q of tries) {
        let hits = [];
        try { hits = await this.search(q); } catch (e) { if (q === 'abstract') throw e; continue; }
        const usable = hits.filter(h => this.pickUrl(h) && (allowPeople || !PEOPLE.test(String(h.tags || ''))));
        const pref = (process.env.PIXABAY_PREFER || 'computer,digital,technology,laptop,code,data,network,screen,robot,artificial,intelligence,software').split(',');
        const score = h => { const t = String(h.tags || '').toLowerCase(); return words.filter(w => t.includes(w)).length * 2 + pref.filter(w => t.includes(w)).length; };
        usable.sort((a, b) => score(b) - score(a));
        const pick = usable.find(h => !this.used.has(h.id)) || usable[0];
        if (pick) {
          this.used.add(pick.id);
          if (this.used.size > 300) this.used.clear();
          console.log('[Pixabay] q="' + q + '" -> ' + pick.id + ' (' + pick.tags + ')');
          return { externalTaskId: 'pixabay_' + pick.id, status: 'succeeded', outputUrl: this.pickUrl(pick), model: 'pixabay-stock', error: null, queryUsed: q, tags: pick.tags };
        }
      }
      throw new Error('Pixabay returned no usable clip for: ' + (tries[0] || hint));
    }

    async getTask(id) { return { externalTaskId: id, status: 'succeeded', outputUrl: null, error: null }; }
  };
};
