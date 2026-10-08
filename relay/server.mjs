// Collab relay: routes questions and answers between teammates' Claude Code sessions.
// No dependencies. Config via env:
//   COLLAB_TOKENS   JSON map of token -> person, e.g. {"tok-abc":"denis","tok-def":"dwight"}
//   PORT            default 8790
//   HOST            default 127.0.0.1 (the relay sits behind Caddy; set 0.0.0.0 only to expose it directly)
//   TZ              timestamps use local time, e.g. TZ=America/Chicago
import http from 'node:http'
import { randomBytes } from 'node:crypto'

const tokens = JSON.parse(process.env.COLLAB_TOKENS ?? '{}')
const port = Number(process.env.PORT ?? 8790)
const MAX_BODY = 32 * 1024
// Monitor notifications get cut off around 500 chars; above this we point at `collab thread`.
const LONG_BODY = 400

// session id -> { person, repo, res (SSE response), available, since }
const sessions = new Map()
// thread id -> { id, from: {person, session, repo}, to: {person, session}, messages: [{who, status, text, at}] }
const threads = new Map()
// person -> thread ids asked while they were offline, delivered on their next /online
const queued = new Map()

const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false })
const log = (...a) => console.log(now(), ...a)

function personOf(req) {
    const header = req.headers.authorization ?? ''
    return tokens[header.replace(/^Bearer /, '')]
}

// Body lines are quoted so a message can never pass as relay framing.
function push(sessionId, header, body = '', threadId = '') {
    const s = sessions.get(sessionId)
    if (!s) return false
    const lines = [header]
    if (body) lines.push(...body.split('\n').map(l => `> ${l}`))
    if (body.length > LONG_BODY) lines.push(`(long message: run collab thread ${threadId} for the full text)`)
    s.res.write(lines.map(l => `data: ${l}\n`).join('') + '\n')
    return true
}

function questionHeader(thread) {
    return `[collab] question ${thread.id} from ${thread.from.person}'s Claude (${thread.from.repo}). Answer with: collab reply ${thread.id}`
}

function availableSessionOf(person) {
    return [...sessions.entries()].find(([, s]) => s.person === person && s.available)?.[0]
}

function newThreadId() {
    let id
    do id = 'q' + randomBytes(2).toString('hex'); while (threads.has(id))
    return id
}

// Returns null when the body is over MAX_BODY. Strips ANSI escapes and control chars (keeps \n and \t).
async function readBody(req) {
    let body = ''
    for await (const chunk of req) {
        body += chunk
        if (body.length > MAX_BODY) return null
    }
    return body
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .trim()
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    const q = Object.fromEntries(url.searchParams)
    const person = personOf(req)
    const route = `${req.method} ${url.pathname}`
    const send = (status, text) => { res.writeHead(status, { 'content-type': 'text/plain' }); res.end(text + '\n') }

    if (!person) return send(401, 'unknown token: run /collab:setup <token>')

    switch (route) {
        case 'GET /me':
            return send(200, `you are ${person}`)

        case 'GET /stream': {
            if (!q.session) return send(400, 'session required')
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
            res.write(': connected\n\n')
            const previous = sessions.get(q.session)
            // After a relay restart, a session that was online says so and gets its spot back if it's still free.
            const reclaim = q.online === '1' && !availableSessionOf(person)
            sessions.set(q.session, { person, repo: q.repo ?? '?', res, available: previous?.available ?? reclaim, since: now() })
            const ping = setInterval(() => res.write(': ping\n\n'), 25000)
            log('connect', person, q.repo, q.session)
            req.on('close', () => {
                clearInterval(ping)
                if (sessions.get(q.session)?.res === res) sessions.delete(q.session)
                log('disconnect', person, q.session)
            })
            return
        }

        case 'POST /online': {
            const s = sessions.get(q.session)
            if (!s || s.person !== person) return send(409, 'this session has no live connection to the relay; run /reload-plugins (or restart Claude Code) and try again')
            for (const [id, other] of sessions) {
                if (other.person === person && other.available && id !== q.session) {
                    other.available = false
                    push(id, `[collab] no longer online: replaced by a session in ${s.repo}`)
                }
            }
            s.available = true
            s.since = now()
            const waiting = queued.get(person) ?? []
            queued.delete(person)
            for (const id of waiting) {
                const thread = threads.get(id)
                thread.to.session = q.session
                push(q.session, questionHeader(thread), thread.messages[0].text, thread.id)
            }
            log('online', person, s.repo, waiting.length ? `delivered ${waiting.length} queued` : '')
            return send(200, `online: questions for ${person} now come to this session (${s.repo})${waiting.length ? `; ${waiting.length} queued question(s) delivered` : ''}`)
        }

        case 'POST /offline': {
            const s = sessions.get(q.session)
            if (s?.person === person) s.available = false
            return send(200, `offline: this session no longer takes questions`)
        }

        case 'GET /who': {
            const people = [...new Set(Object.values(tokens))]
            const lines = people.map(p => {
                const id = availableSessionOf(p)
                return id ? `${p}: online in ${sessions.get(id).repo} since ${sessions.get(id).since}` : `${p}: offline`
            })
            return send(200, lines.join('\n'))
        }

        case 'POST /ask': {
            if (!Object.values(tokens).includes(q.to)) return send(404, `no teammate named ${q.to}`)
            const text = await readBody(req)
            if (text === null) return send(413, `message too long (${MAX_BODY / 1024} KB max)`)
            if (!text) return send(400, 'question text required (send it on stdin)')
            const target = availableSessionOf(q.to)
            const thread = {
                id: newThreadId(),
                from: { person, session: q.session, repo: sessions.get(q.session)?.repo ?? '?' },
                to: { person: q.to, session: target ?? null },
                messages: [{ who: person, text, at: now() }],
            }
            threads.set(thread.id, thread)
            if (!target) {
                queued.set(q.to, [...(queued.get(q.to) ?? []), thread.id])
                log('ask', thread.id, person, '->', q.to, 'queued')
                return send(202, `${q.to} is offline; queued as ${thread.id}, delivers when they next go online`)
            }
            push(target, questionHeader(thread), text, thread.id)
            log('ask', thread.id, person, '->', q.to)
            return send(200, `sent as ${thread.id}; the answer will arrive in this session as a collab notification`)
        }

        case 'POST /reply': {
            const thread = threads.get(q.id)
            if (!thread) return send(404, `no thread ${q.id}`)
            const mine = thread.from.person === person ? 'from' : thread.to.person === person ? 'to' : null
            if (!mine) return send(403, `thread ${q.id} is not yours`)
            const other = mine === 'from' ? thread.to : thread.from
            const text = await readBody(req)
            if (text === null) return send(413, `message too long (${MAX_BODY / 1024} KB max)`)
            if (!text) return send(400, 'reply text required (send it on stdin)')
            const status = q.status ?? ''
            thread.messages.push({ who: person, status, text, at: now() })
            // A follow-up from the asker goes to whichever session is answering for that person now.
            if (mine === 'from') other.session = availableSessionOf(other.person) ?? other.session
            const label = status === 'escalated' ? 'escalated to the human' : mine === 'from' ? 'follow-up' : 'answer'
            const delivered = push(other.session, `[collab] ${label} on ${thread.id} from ${person}'s Claude. Reply with: collab reply ${thread.id}`, text, thread.id)
            log('reply', thread.id, person, label, delivered ? 'delivered' : 'stored')
            return send(200, delivered ? `delivered to ${other.person}` : `${other.person}'s session is gone; stored on ${thread.id} (collab thread ${thread.id})`)
        }

        case 'GET /thread': {
            const thread = threads.get(q.id)
            if (!thread || ![thread.from.person, thread.to.person].includes(person)) return send(404, `no thread ${q.id}`)
            return send(200, thread.messages.map(m => `[${m.at}] ${m.who}${m.status ? ` (${m.status})` : ''}:\n${m.text}`).join('\n\n'))
        }
    }

    send(404, 'not found')
})

const host = process.env.HOST ?? '127.0.0.1'
server.listen(port, host, () => log(`collab relay on ${host}:${port}`))
