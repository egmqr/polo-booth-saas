function uploadTime(object) {
    const time = object.uploaded instanceof Date ? object.uploaded.getTime() : new Date(object.uploaded).getTime();
    return Number.isFinite(time) ? time : 0;
}

export function timelineForObject(object) {
    const key = String(object.key || '');
    const name = key.split('/').pop() || '';
    const match = /^c-(\d+)-/.exec(name);
    const time = match ? Number(match[1]) : uploadTime(object);

    return {
        time: Number.isSafeInteger(time) ? time : uploadTime(object),
        id: match ? (name.slice(match[0].length) || key) : key
    };
}

export function compareTimeline(a, b) {
    const left = timelineForObject(a);
    const right = timelineForObject(b);
    return left.time - right.time || left.id.localeCompare(right.id);
}
