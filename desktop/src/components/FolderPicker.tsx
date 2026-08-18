import type { CopyCatalog } from "../types";

type Props = {
  roots: string[];
  copy: CopyCatalog;
  disabled?: boolean;
  onAdd: () => void;
  onRemove: (root: string) => void;
};

export function FolderPicker({ roots, copy, disabled, onAdd, onRemove }: Props) {
  return (
    <section class="folder-picker" aria-labelledby="folder-title">
      <div class="section-heading">
        <div>
          <h2 id="folder-title">{copy.chooseFolders}</h2>
          <p>{copy.chooseFoldersHint}</p>
        </div>
        <button class="button button-secondary" type="button" disabled={disabled} onClick={onAdd}>{copy.addFolder}</button>
      </div>
      {roots.length === 0 ? (
        <p class="empty-state">{copy.noFolders}</p>
      ) : (
        <ul class="folder-list" aria-label={copy.folderListLabel}>
          {roots.map((root) => (
            <li class="folder-item" key={root}>
              <span class="folder-icon" aria-hidden="true">⌂</span>
              <code title={root}>{root}</code>
              <button
                class="icon-button"
                type="button"
                disabled={disabled || roots.length <= 1}
                onClick={() => onRemove(root)}
                aria-label={`${copy.removeFolder} ${root}`}
                title={roots.length <= 1 ? copy.keepOneFolder : copy.removeFolder}
              >×</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
