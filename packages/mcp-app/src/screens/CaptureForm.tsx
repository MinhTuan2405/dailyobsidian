import { useState } from "react";

export interface CaptureProposal {
  title: string;
  content: string;
  path: string;
  tags: string[];
  sourceUrl?: string;
}

export function CaptureForm({
  inboxFolder,
  onPreview,
}: {
  inboxFolder: string;
  onPreview: (proposal: CaptureProposal) => Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [destination, setDestination] = useState("inbox");
  const [customPath, setCustomPath] = useState("");
  const [tags, setTags] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function submit() {
    const cleanTitle = title.trim();
    if (cleanTitle === "" || content.trim() === "") {
      setError("Title and content are required before preview.");
      return;
    }
    const path =
      destination === "custom"
        ? customPath.trim()
        : `${inboxFolder}/${cleanTitle.replace(/[\\/:*?"<>|]/g, "-")}.md`;
    if (path === "" || !path.toLocaleLowerCase().endsWith(".md")) {
      setError("Choose an explicit Markdown destination.");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      await onPreview({
        title: cleanTitle,
        content,
        path,
        tags: tags
          .split(/[ ,]+/)
          .map((tag) => tag.replace(/^#/, "").trim())
          .filter(Boolean),
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      });
    } catch {
      setError("The capture preview could not be generated.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="screen capture-screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">05 / Intake card</p>
          <h1>Capture without losing the voice</h1>
        </div>
        <span className="header-note">Preview is mandatory.</span>
      </header>
      <div className="capture-grid">
        <label>
          <span>Title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          <span>Destination</span>
          <select
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
          >
            <option value="inbox">Inbox</option>
            <option value="daily">Daily note</option>
            <option value="project">Project note</option>
            <option value="custom">Custom path</option>
          </select>
        </label>
        {destination === "custom" ? (
          <label className="wide">
            <span>Custom path</span>
            <input
              value={customPath}
              onChange={(event) => setCustomPath(event.target.value)}
              placeholder="Projects/Field note.md"
            />
          </label>
        ) : null}
        <label className="wide">
          <span>Content</span>
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={10}
          />
        </label>
        <label>
          <span>Tags</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
          />
        </label>
        <label>
          <span>Source URL</span>
          <input
            type="url"
            value={sourceUrl}
            onChange={(event) => setSourceUrl(event.target.value)}
          />
        </label>
        <label>
          <span>Template</span>
          <select defaultValue="none">
            <option value="none">No template</option>
          </select>
        </label>
        <div className="frontmatter-preview">
          <span>Frontmatter preview</span>
          <code>tags: [{tags || ""}]</code>
          <code>source: {sourceUrl || "--"}</code>
        </div>
      </div>
      {error ? <p className="inline-error">{error}</p> : null}
      <footer className="screen-footer">
        <button
          className="button primary"
          disabled={loading}
          onClick={() => void submit()}
        >
          {loading ? "Preparing..." : "Preview capture"}
        </button>
      </footer>
    </section>
  );
}
