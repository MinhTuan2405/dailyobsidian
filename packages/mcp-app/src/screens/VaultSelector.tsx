import type { VaultInfo } from "@obsidian-workbench/shared";

export function VaultSelector({
  vaults,
  selectedVaultId,
  onSelect,
}: {
  vaults: VaultInfo[];
  selectedVaultId?: string;
  onSelect: (vaultId: string) => void;
}) {
  return (
    <section className="screen vault-screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">01 / Connection ledger</p>
          <h1>Authorized vaults</h1>
        </div>
        <p className="header-note">Select the boundary before the work.</p>
      </header>
      <div className="vault-grid">
        {vaults.map((vault, index) => {
          const selected = vault.vaultId === selectedVaultId;
          const writable = vault.capabilities.scopes.some(
            (scope) => scope.startsWith("notes.") && scope !== "notes.read",
          );
          return (
            <button
              className={`vault-card${selected ? " selected" : ""}`}
              key={vault.vaultId}
              onClick={() => onSelect(vault.vaultId)}
              aria-pressed={selected}
            >
              <span className="vault-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className={`signal ${vault.status.state}`}>
                {vault.status.state}
              </span>
              <strong>{vault.name}</strong>
              <code>{vault.vaultId}</code>
              <span>{writable ? "Read + scoped write" : "Read only"}</span>
              <span className="roots">
                Allowed: {vault.allowedRoots.join(", ") || "none"}
              </span>
              <span className="roots muted">
                Excluded: {vault.excludedRoots.join(", ") || "none"}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
