/**
 * Package W: how long the server keeps what it stores, and the plain-words privacy note the main menu shows.
 * One place for both, so the note cannot drift from what the server does: the server uses these numbers as
 * its defaults (server/src/datastore.ts; each can be overridden by an environment variable on the server,
 * which the live server does not do), and `client/src/ui.ts` draws `PRIVACY_SECTIONS`.
 */

/** Input recordings older than this are deleted. */
export const RECORD_KEEP_DAYS = 90;
/** Input recordings are kept at most this many megabytes in all; the oldest go first. */
export const RECORD_MAX_MB = 2000;
/** Match records are kept in monthly files; files older than this many months are deleted. */
export const MATCH_KEEP_MONTHS = 12;

export interface PrivacySection {
    title: string;
    lines: readonly string[];
}

export const PRIVACY_SECTIONS: readonly PrivacySection[] = [
    {
        title: 'What the game server keeps',
        lines: [
            'The name you play under.',
            'What happens in your matches: your movement and button presses during matches, hits, kills, plants, defuses, and each round\'s and match\'s result.',
            'Feedback notes you send with "Send feedback".',
            'Automatic error reports when the game breaks: the error message, your browser and its version, your graphics card\'s name, frame rate, ping and which room and map you were in.'
        ]
    },
    {
        title: 'What it does not keep',
        lines: [
            'Your IP address is used only while you are connected, to limit connections and to enforce a vote-kick ban for 10 minutes. It is not written into match records, recordings or reports.',
            'Chat is not recorded. Nothing is kept from the practice range or the warmup lobby.',
            'There are no accounts, no email addresses and no tracking or advertising cookies.'
        ]
    },
    {
        title: 'Why',
        lines: [
            'To fix bugs, to balance the game (for example how often ghosts win, and how), and to make the computer players behave more like people.'
        ]
    },
    {
        title: 'How long',
        lines: [
            `Recordings of matches are deleted after ${RECORD_KEEP_DAYS} days, sooner if they take more than ${RECORD_MAX_MB / 1000} GB in all (the oldest first).`,
            `Match records are deleted after ${MATCH_KEEP_MONTHS} months.`,
            'Feedback notes and error reports are kept until the developer has read and deleted them.'
        ]
    }
];
