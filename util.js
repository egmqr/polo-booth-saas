export function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8' }
    });
}

export function cors(res) {
    const r = new Response(res.body, res);
    r.headers.set('access-control-allow-origin', '*');
    r.headers.set('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
    r.headers.set('access-control-allow-headers', 'content-type, authorization');
    return r;
}

export function decodeBase64(str) {
    const clean = str.includes(',') ? str.split(',')[1] : str;
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

export function safePrefix(p) {
    if (!p) return null;
    if (/^\//.test(p) || /\.\./.test(p) || !/^[A-Za-z0-9._/-]+$/.test(p)) return null;
    return p.replace(/\/+$/, '');
}