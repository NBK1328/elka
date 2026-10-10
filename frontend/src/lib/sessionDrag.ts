/**
 * A dragged terminal has to stay visible under the cursor, otherwise the drag is indistinguishable
 * from plain mouse movement. There are two drag paths, each with its own constraints:
 *
 *  - A tab in the top tray is dragged with our own pointer events: the browser drag does not work
 *    there, so we draw the image under the cursor ourselves.
 *  - The header of a split-screen pane is dragged with the native HTML5 drag, where the browser
 *    draws the image but takes it from the source element: for a header that is a 24px strip, and
 *    dragging a pane would look like stray text selection. So the image is swapped in through
 *    setDragImage.
 *
 * The shared layer is drawn straight into the DOM rather than through React: the pointer delivers
 * events more often than the screen refreshes, and re-rendering the tab tray on every move would
 * noticeably slow the drag down.
 */

const GHOST_CLASSES = [
    "pointer-events-none fixed left-0 top-0 z-999 flex max-w-64 select-none items-center gap-2 truncate",
    "rounded-md border border-border bg-popover px-3 py-1.5",
    "text-xs font-medium text-popover-foreground shadow-lg",
].join(" ");

/** How far the ghost is offset from the cursor so it does not cover the drop highlight. */
const GHOST_OFFSET = {x: 12, y: 10};

let overlay: HTMLDivElement | null = null;

function buildGhost(label: string): HTMLDivElement {
    const ghost = document.createElement("div");
    ghost.className = GHOST_CLASSES;
    ghost.textContent = label;
    return ghost;
}

/**
 * Shows the drag image under the cursor. Called once at the start of a drag, after which the image
 * is only moved by calls to moveSessionDragGhost.
 */
export function showSessionDragGhost(label: string): void {
    hideSessionDragGhost();

    overlay = buildGhost(label);
    // The first frame is parked outside the window: the ghost has to appear at the right size right
    // away, otherwise it jumps in from the top left corner on the very first move.
    overlay.style.transform = "translate3d(-9999px, -9999px, 0)";
    document.body.appendChild(overlay);
}

export function moveSessionDragGhost(clientX: number, clientY: number): void {
    if (!overlay) return;

    // transform only: unlike left/top it does not trigger a layout recalculation.
    overlay.style.transform = `translate3d(${clientX - GHOST_OFFSET.x}px, ${clientY - GHOST_OFFSET.y}px, 0)`;
}

export function hideSessionDragGhost(): void {
    overlay?.remove();
    overlay = null;
}

/**
 * Swaps the native HTML5 drag image for the same ghost the pointer drag uses.
 *
 * The element has to be laid out at the moment of the call: the engine snapshots it not
 * immediately but on the next frame, so the node stays in the document until the drag ends and is
 * removed on dragend. The timer is a fallback in case the drag is cut off without an event.
 */
export function attachSessionDragImage(event: {dataTransfer: DataTransfer}, label: string): void {
    const ghost = buildGhost(label);
    ghost.style.transform = "translate3d(-9999px, -9999px, 0)";
    document.body.appendChild(ghost);

    const remove = () => ghost.remove();
    event.dataTransfer.setDragImage(ghost, GHOST_OFFSET.x, GHOST_OFFSET.y);
    window.addEventListener("dragend", remove, {once: true});
    window.setTimeout(remove, 1000);
}