export function StatusPanel({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <section className="status-panel" role="status">
      <span className="status-mark" aria-hidden="true">
        OW
      </span>
      <p className="eyebrow">Connection notice</p>
      <h1>{title}</h1>
      <p>{message}</p>
      {action ? (
        <button className="button primary" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </section>
  );
}
