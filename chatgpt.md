What you’re actually building

An “online IFC viewer running locally in the browser” means:

Load .ifc files (user uploads / drag-drop)
Parse IFC (STEP format)
Convert to renderable geometry
Display in WebGL (Three.js or similar)
Allow navigation (orbit, pan, zoom)
Optionally: selection, metadata, filtering
🧱 Core building blocks (already exist)
1. IFC parsing

The hardest part—but solved by:

web-ifc
WASM-based IFC parser
Runs fully in the browser
Maintained by That Open Company (formerly IFC.js team)

👉 This is the key enabler. Without it, the project becomes very hard.

2. Rendering
Three.js
Standard WebGL abstraction
Huge ecosystem
3. Higher-level viewer frameworks

Instead of wiring everything yourself:

IFC.js
That Open Engine

These already combine parsing + rendering + interaction.

⚙️ Difficulty breakdown
🟢 Basic viewer (easy–moderate, 1–3 days)
Load IFC
Render geometry
Orbit controls

👉 With IFC.js / That Open Engine: surprisingly quick

🟡 Intermediate (moderate, 1–3 weeks)
Object selection
Highlighting
Tree view (spatial structure)
Property inspection

👉 Requires understanding IFC structure (IFC schema)

🔴 Advanced (hard, months)
Large model performance (100MB+ IFCs)
Streaming / chunking
Clash detection
Section cuts
Measurement tools
Editing IFC

👉 This is where complexity explodes

🚧 Main challenges
1. Performance

IFC files can be huge:

Parsing is CPU-heavy (WASM helps but still costly)
Geometry can be millions of triangles

You’ll need:

Geometry batching
Instancing
Lazy loading (optional but important)
2. IFC complexity

IFC is not simple:

Deep relational schema
Geometry definitions are indirect
Metadata extraction is non-trivial
3. Browser constraints
Memory limits (especially on mobile)
No filesystem access (must use file input / drag-drop)
Single-thread bottlenecks (Web Workers help)
🧠 Realistic assessment

If your goal is:

“Simple local viewer”

✔️ Totally feasible
✔️ No backend needed
✔️ Can be done in days

“Production-grade BIM viewer (like Autodesk)”

❌ Very complex
❌ Requires serious optimization + domain knowledge
❌ Likely months of work

🧪 Minimal stack example
web-ifc → parse IFC
three → render
IFCLoader (from IFC.js) → bridge between them
💡 Key insight

The hardest problem (IFC parsing) is already solved by WASM libraries.

So your real work becomes:

UX + performance + feature layering

—not geometry math or file parsing.

👍 Recommendation

If you want to build this:

Start with IFC.js examples
Strip it down to a minimal viewer
Then add features incrementally

If you want, I can 
sketch a minimal working architecture or starter code for a local-only IFC viewer (React or vanilla).