// 1CCoder: opencode's developer aids -- the blue channel badge in the title bar
// and the debug bar along the bottom -- are hidden unless asked for. They only
// ever appear in dev builds, but that is where the product is looked at and
// demonstrated most, and to anyone but an opencode developer they are noise.
//
// Start the dev app with VITE_1CCODER_DEBUG_TOOLS=1 to get both back exactly as
// upstream has them, including the badge's click-to-toggle of the bar.
export const debugToolsEnabled = import.meta.env.VITE_1CCODER_DEBUG_TOOLS === "1"
