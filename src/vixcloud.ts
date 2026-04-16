import * as cheerio from 'cheerio';
import { request } from 'undici';
import { config } from './config';
import { makeProxyToken, VIXCLOUD_HEADERS } from './proxy';

const ANIMEMAPPING_BASE = 'https://animemapping.stremio.dpdns.org';
const AU_BASE = 'https://www.animeunity.so';
const AU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// ── Step 1: Resolve tutti i path AnimeUnity dalla mapping API ──
async function resolveAllMappings(kitsuId: string, episodeNum: string): Promise<{path: string, type: string}[]> {
    try {
        const ep = parseInt(episodeNum) || 1;
        const url = `${ANIMEMAPPING_BASE}/kitsu/${kitsuId}?ep=${ep}`;
        console.log(`[VixCloud] Fetching mapping: ${url}`);
        const { body, statusCode } = await request(url, { headers: { 'Accept': 'application/json' } });
        if (statusCode !== 200) {
            console.log(`[VixCloud] Mapping API returned ${statusCode}`);
            return [];
        }
        const data: any = await body.json();
        
        const auMapping = data?.mappings?.animeunity;
        if (!auMapping) return [];

        const paths = Array.isArray(auMapping) ? auMapping : [auMapping];
        const results: {path: string, type: string}[] = [];

        for (const item of paths) {
            const path = typeof item === 'string' ? item : (item?.path || item?.url || item?.href || null);
            if (!path) continue;

            // Prova prima il campo type/audio dall'API
            let type = (typeof item === 'object' ? (item?.type || item?.audio || '') : '').toLowerCase();

            // Se il tipo non è riconosciuto, deducilo dal slug (AnimeUnity usa sempre "-ita" per il doppiato)
            if (!type || type === 'unknown') {
                type = path.toLowerCase().includes('-ita') ? 'ita' : 'jp';
            }

            results.push({ path, type });
            console.log(`[VixCloud] Mapping found path: ${path} type: ${type}`);
        }

        return results;
    } catch (err: any) {
        console.error('[VixCloud] Mapping API error:', err?.message || err);
        return [];
    }
}
// ── Step 2: Get episode number from mapping ──
async function resolveEpisodeFromMapping(kitsuId: string, episodeNum: string): Promise<number> {
    try {
        const ep = parseInt(episodeNum) || 1;
        const url = `${ANIMEMAPPING_BASE}/kitsu/${kitsuId}?ep=${ep}`;
        const { body, statusCode } = await request(url, { headers: { 'Accept': 'application/json' } });
        if (statusCode !== 200) return ep;
        const data: any = await body.json();
        
        const fromKitsu = data?.kitsu?.episode;
        if (fromKitsu && typeof fromKitsu === 'number' && fromKitsu > 0) return fromKitsu;
        const fromRequested = data?.requested?.episode;
        if (fromRequested && typeof fromRequested === 'number' && fromRequested > 0) return fromRequested;
        return ep;
    } catch {
        return parseInt(episodeNum) || 1;
    }
}

// ── Step 3: Kitsu canonical title fallback ──
async function getKitsuTitle(kitsuId: string): Promise<string | null> {
    try {
        const { body, statusCode } = await request(`https://kitsu.io/api/edge/anime/${kitsuId}`);
        if (statusCode !== 200) return null;
        const data: any = await body.json();
        const attr = data?.data?.attributes;
        return attr?.titles?.en || attr?.titles?.en_jp || attr?.canonicalTitle || null;
    } catch {
        return null;
    }
}

// ── Step 4: AnimeUnity session + search ──
async function getAnimeUnitySession(): Promise<{csrfToken: string, cookie: string}> {
    const { body, headers } = await request(AU_BASE, {
        headers: { 'User-Agent': AU_UA }
    });
    const html = await body.text();
    const $ = cheerio.load(html);
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || '';
    let cookie = '';
    const setCookieHeader = headers['set-cookie'];
    if (setCookieHeader) {
         if (Array.isArray(setCookieHeader)) {
             cookie = setCookieHeader.map((c: string) => c.split(';')[0]).join('; ');
         } else {
             cookie = String(setCookieHeader).split(';')[0] || '';
         }
    }
    return { csrfToken, cookie };
}

async function searchAnimeUnity(title: string, session: {csrfToken: string, cookie: string}): Promise<any[]> {
    const { body } = await request(`${AU_BASE}/livesearch`, {
        method: 'POST',
        headers: {
            'User-Agent': AU_UA,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/json;charset=utf-8',
            'X-CSRF-Token': session.csrfToken,
            'Referer': AU_BASE + '/',
            'Cookie': session.cookie
        },
        body: JSON.stringify({ title })
    });
    const result: any = await body.json();
    return result?.records || [];
}

// ── Step 5: Extract embed URL from AnimeUnity anime page ──
async function getEmbedUrl(animePath: string, episodeNum: number): Promise<string | null> {
    const animeUrl = animePath.startsWith('http') ? animePath : `${AU_BASE}${animePath}`;
    console.log(`[VixCloud] Fetching anime page: ${animeUrl}`);
    
    const { body } = await request(animeUrl, {
        headers: { 'User-Agent': AU_UA }
    });
    const html = await body.text();
    const $ = cheerio.load(html);
    
    const vp = $('video-player').first();
    const episodesStr = vp.attr('episodes') || '[]';
    
    let parsedEpisodes: any[] = [];
    try {
        const unescaped = episodesStr
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
        parsedEpisodes = JSON.parse(unescaped);
    } catch(e) {
        console.error('[VixCloud] Failed to parse episodes JSON');
        return null;
    }

    const targetEp = parsedEpisodes.find((e: any) => {
        const num = parseFloat(String(e.number || ''));
        return num === episodeNum;
    });
    
    if (!targetEp) {
        console.log(`[VixCloud] Episode ${episodeNum} not found in ${parsedEpisodes.length} episodes`);
        if (parsedEpisodes.length === 1) {
            const singleEp = parsedEpisodes[0];
            return singleEp.embed_url || null;
        }
        return null;
    }

    const epPageUrl = `${animeUrl}/${targetEp.id}`;
    console.log(`[VixCloud] Fetching episode page: ${epPageUrl}`);
    
    const { body: epBody } = await request(epPageUrl, {
        headers: { 'User-Agent': AU_UA }
    });
    const epHtml = await epBody.text();
    const $ep = cheerio.load(epHtml);
    
    let embedUrl = $ep('video-player').first().attr('embed_url');
    if (!embedUrl) {
        embedUrl = $ep('iframe[src*="vixcloud"]').first().attr('src');
    }
    if (embedUrl && !embedUrl.startsWith('http')) {
        embedUrl = AU_BASE + embedUrl;
    }
    
    return embedUrl || null;
}

// ── Step 6: Extract HLS manifest from VixCloud embed ──
async function extractVixCloudManifest(embedUrl: string): Promise<string | null> {
    console.log(`[VixCloud] Extracting manifest from embed: ${embedUrl}`);
    
    const inputUrlObj = new URL(embedUrl);
    const tokenFromInput = inputUrlObj.searchParams.get('token');
    const expiresFromInput = inputUrlObj.searchParams.get('expires');
    const asnFromInput = inputUrlObj.searchParams.get('asn');

    const { body, statusCode } = await request(embedUrl, {
        headers: VIXCLOUD_HEADERS
    });

    let html = "";
    if (statusCode === 200) {
        html = await body.text();
    } else if (statusCode === 403 && tokenFromInput && expiresFromInput) {
        console.log("[VixCloud] 403 Received, but tokens provided in URL. Using fallback.");
    } else {
        console.log(`[VixCloud] Embed fetch failed with status ${statusCode}`);
        return null;
    }
    
    let token = tokenFromInput || "";
    let expires = expiresFromInput || "";
    let asn = asnFromInput || "";
    let playlistUrl = "";

    const masterPlaylistMatch = html.match(/window\.masterPlaylist\s*=\s*\{.*?params\s*:\s*\{(?<params>.*?)\}\s*,\s*url\s*:\s*['"](?<url>[^'"]+)['"]/s);
    
    if (masterPlaylistMatch?.groups) {
        const paramsBlock = masterPlaylistMatch.groups.params;
        playlistUrl = masterPlaylistMatch.groups.url.replace(/\\/g, '');
        
        const tMatch = paramsBlock.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
        const eMatch = paramsBlock.match(/['"]expires['"]\s*:\s*['"]([^'"]+)['"]/);
        const aMatch = paramsBlock.match(/['"]asn['"]\s*:\s*['"]([^'"]+)['"]/);
        
        if (tMatch) token = tMatch[1];
        if (eMatch) expires = eMatch[1];
        if (aMatch) asn = aMatch[1];
    } else {
        const urlMatch = html.match(/masterPlaylist[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/) || html.match(/url\s*:\s*['"](https?:[^'"]+\/playlist\/[^'"]+)['"]/);
        const tMatch = html.match(/token['"]\s*:\s*['"]([^'"]+)['"]/);
        const eMatch = html.match(/expires['"]\s*:\s*['"](\d+)['"]/);
        const aMatch = html.match(/asn['"]\s*:\s*['"]([^'"]*)['"]/);

        if (urlMatch) playlistUrl = urlMatch[1].replace(/\\/g, '');
        if (tMatch && !token) token = tMatch[1];
        if (eMatch && !expires) expires = eMatch[1];
        if (aMatch && !asn) asn = aMatch[1];
    }

    if (!playlistUrl) {
        const videoIdMatch = embedUrl.match(/\/embed\/(\d+)/);
        if (videoIdMatch) {
            playlistUrl = `${inputUrlObj.origin}/playlist/${videoIdMatch[1]}`;
        }
    }

    if (!token || !expires || !playlistUrl) {
        console.log(`[VixCloud] Extraction failed: token=${!!token} expires=${!!expires} url=${!!playlistUrl}`);
        return null;
    }

    const finalUrlObj = new URL(playlistUrl);
    finalUrlObj.searchParams.set('token', token);
    finalUrlObj.searchParams.set('expires', expires);
    if (asn) finalUrlObj.searchParams.set('asn', asn);
    
    const canFHD = /canPlayFHD\s*=\s*true/i.test(html) || inputUrlObj.searchParams.get('canPlayFHD') === '1';
    if (canFHD) finalUrlObj.searchParams.set('h', '1');

    console.log(`[VixCloud] Extracted manifest: ${finalUrlObj.toString()}`);
    return ensureM3u8(finalUrlObj.toString());
}

function ensureM3u8(url: string): string {
    try {
        const u = new URL(url);
        if (u.pathname.includes('/playlist/')) {
            const parts = u.pathname.split('/');
            const leaf = parts[parts.length - 1];
            if (leaf && !leaf.includes('.') && !leaf.endsWith('.m3u8')) {
                u.pathname = u.pathname + '.m3u8';
                return u.toString();
            }
        }
        return url;
    } catch { return url; }
}

// ── Helpers tipo audio ──
function isIta(type: string): boolean {
    return type === 'ita' || type === 'it' || type === 'dub' || type === 'dubbed';
}

function isJpSub(type: string): boolean {
    return type === 'jp' || type === 'sub' || type === 'jp_ita' || type === 'subita' || type === '' || type === 'jpn';
}

// ── Main entry point ──
export async function getVixCloudStreams(kitsuId: string, episodeNumber: string = "1"): Promise<{name: string, title: string, url: string}[]> {
    try {
        console.log(`[VixCloud] Resolving kitsu:${kitsuId} ep=${episodeNumber}`);
        
        const resolvedEp = await resolveEpisodeFromMapping(kitsuId, episodeNumber);
        const mappedPaths = await resolveAllMappings(kitsuId, episodeNumber);

        let itaPath = mappedPaths.find(m => isIta(m.type));
        let jpPath  = mappedPaths.find(m => isJpSub(m.type));

        if (!itaPath && !jpPath && mappedPaths.length > 0) {
            jpPath  = mappedPaths[0];
            itaPath = mappedPaths[1];
        }

        let itaEmbed: string | null = null;
        let jpEmbed:  string | null = null;

        if (itaPath) itaEmbed = await getEmbedUrl(itaPath.path, resolvedEp);
        if (jpPath)  jpEmbed  = await getEmbedUrl(jpPath.path,  resolvedEp);

        // ── Fallback search: scatta se manca ITA o JP (|| non &&) ──
        if (!itaEmbed || !jpEmbed) {
            const title = await getKitsuTitle(kitsuId);
            if (title) {
                console.log(`[VixCloud] Searching AnimeUnity for missing stream(s): "${title}"`);
                const session = await getAnimeUnitySession();
                const searchResults = await searchAnimeUnity(title, session);

                if (searchResults.length > 0) {
                    const itaResult = searchResults.find((a: any) => isIta((a.type || '').toLowerCase()));
                    const jpResult  = searchResults.find((a: any) => isJpSub((a.type || '').toLowerCase()));

                    if (!itaEmbed && itaResult) {
                        const path = `/anime/${itaResult.id}-${itaResult.slug}`;
                        console.log(`[VixCloud] ITA from search: id=${itaResult.id} type=${itaResult.type}`);
                        itaEmbed = await getEmbedUrl(path, resolvedEp);
                    }

                    if (!jpEmbed && jpResult) {
                        const path = `/anime/${jpResult.id}-${jpResult.slug}`;
                        console.log(`[VixCloud] JP from search: id=${jpResult.id} type=${jpResult.type}`);
                        jpEmbed = await getEmbedUrl(path, resolvedEp);
                    }

                    // Ultimo fallback: se AnimeUnity non distingue i tipi usa i primi 2 risultati
                    if (!jpEmbed && !itaEmbed) {
                        const first  = searchResults[0];
                        const second = searchResults[1];
                        if (first)  jpEmbed  = await getEmbedUrl(`/anime/${first.id}-${first.slug}`, resolvedEp);
                        if (second) itaEmbed = await getEmbedUrl(`/anime/${second.id}-${second.slug}`, resolvedEp);
                    }
                }
            }
        }

        // ── Costruisci gli stream ──
        const streams: {name: string, title: string, url: string}[] = [];

        if (itaEmbed) {
            const manifest = await extractVixCloudManifest(itaEmbed);
            if (manifest) {
                const token = makeProxyToken(manifest, VIXCLOUD_HEADERS);
                streams.push({
                    name: "AU 🤌",
                    title: "VIX 1080 🤌 🇮🇹 Solo ITA",
                    url: `/proxy/hls/manifest.m3u8?token=${token}`
                });
                console.log(`[VixCloud] ITA stream ready`);
            }
        }

        if (jpEmbed) {
            const manifest = await extractVixCloudManifest(jpEmbed);
            if (manifest) {
                const token = makeProxyToken(manifest, VIXCLOUD_HEADERS);
                streams.push({
                    name: "AU 🤌",
                    title: "VIX 1080 🤌 🇯🇵 JAP sub ITA",
                    url: `/proxy/hls/manifest.m3u8?token=${token}`
                });
                console.log(`[VixCloud] JAP sub ITA stream ready`);
            }
        }

        if (streams.length === 0) {
            console.log(`[VixCloud] No streams found`);
        }

        return streams;

    } catch (err: any) {
        console.error("VixCloud Stream extraction error:", err?.message || err);
        return [];
    }
}
