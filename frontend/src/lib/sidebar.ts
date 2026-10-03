// Width of the open rail: padding plus a single column of icon buttons. The rail collapses to nothing,
// so the toggle that brings it back cannot live inside it.
export const SIDEBAR_WIDTH = 56;

// Width of the tab bar column that holds the toggle once the rail is gone: an icon button with a little
// air on both sides. The column keeps this width while the rail is there, which lines the button up with
// the section icons below it.
export const SIDEBAR_TOGGLE_COLUMN_WIDTH = 40;

// How long the rail, the column next to it and their contents take to slide. main.css animates over the
// same window (--sidebar-transition-duration), and the store flag is cleared once it has passed.
export const SIDEBAR_TRANSITION_MS = 200;

// macOS draws its window controls over the top left corner of the frame, so the tab bar keeps that strip
// free there and it sits before the toggle column.
export const MACOS_TRAFFIC_LIGHTS_WIDTH = 72;