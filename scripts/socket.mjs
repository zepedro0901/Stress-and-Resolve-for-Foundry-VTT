import { MODULE_ID } from "./constants.mjs";

const SOCKET = `module.${MODULE_ID}`;
const handlers = {};

/** Register a function the GM runs on behalf of players. */
export function registerHandler(name, fn) {
  handlers[name] = fn;
}

/** The single active GM that handles requests, so they run exactly once. */
function isResponsibleGM() {
  return game.user.isGM && (game.users.activeGM?.id === game.user.id);
}

export function initSocket() {
  game.socket.on(SOCKET, async ({ name, args, userId }) => {
    // Messages addressed to one user run only there; the rest run on the responsible GM.
    if ( userId ? (userId !== game.user.id) : !isResponsibleGM() ) return;
    if ( !handlers[name] ) return;
    const actor = await fromUuid(args.actorUuid);
    if ( !actor ) return;
    const { actorUuid, ...rest } = args;
    await handlers[name](actor, rest);
  });
}

/** Ask the GM to perform an action on an actor this user doesn't own. */
export function requestGM(name, args) {
  if ( !game.users.activeGM ) {
    ui.notifications.warn(game.i18n.localize("SR.Notify.NoGM"));
    return null;
  }
  game.socket.emit(SOCKET, { name, args });
  return null;
}

/** Ask a specific user (e.g. the player who owns a character) to run a handler. */
export function requestUser(userId, name, args) {
  if ( userId === game.user.id ) {
    return fromUuid(args.actorUuid).then(actor => {
      const { actorUuid, ...rest } = args;
      return actor ? handlers[name]?.(actor, rest) : null;
    });
  }
  game.socket.emit(SOCKET, { name, args, userId });
  return null;
}
