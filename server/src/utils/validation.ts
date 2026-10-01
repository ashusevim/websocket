export const LIMITS = {
    username: { min: 3, max: 50 },
    password: { min: 6, max: 128 },
    message: { min: 1, max: 250 },
} as const;

/**
 * Every validator takes `unknown` and narrows before touching `.length`.
 *
 * This is deliberate: request bodies are attacker-controlled, so `username`
 * may be missing, a number, or an object. Reading `.length` off those throws a
 * TypeError, which Express turns into a 500. A malformed body is a client
 * error and must be a 400.
 */
function isBoundedString(
    value: unknown,
    { min, max }: { min: number; max: number },
): value is string {
    if (typeof value !== "string") return false;

    const { length } = value;
    return length >= min && length <= max;
}

export function isValidUsername(username: unknown): username is string {
    return (
        isBoundedString(username, LIMITS.username) &&
        /^[a-zA-Z0-9_]+$/.test(username)
    );
}

export function isValidPassword(password: unknown): password is string {
    return isBoundedString(password, LIMITS.password);
}

export function isValidMessage(message: unknown): message is string {
    return isBoundedString(message, LIMITS.message);
}
