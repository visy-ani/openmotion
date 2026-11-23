import { WebPublishPopover } from '../components/WebPublishPopover';

export interface DesignDeployPopoverProps {
  projectId: string;
  filePath?: string;
  title?: string;
  revisionKey?: string;
  onNotify: (message: string, variant?: 'info' | 'error') => void;
  onCopyUrl: (url: string) => void | Promise<void>;
  onOpenAccount?: () => void;
}

/**
 * Header popover for publishing a Design Studio project to Open Design Cloud
 * via the shared WebPublishPopover abstraction.
 */
export function DesignDeployPopover({
  projectId,
  filePath,
  title,
  revisionKey,
  onNotify,
  onCopyUrl,
  onOpenAccount,
}: DesignDeployPopoverProps) {
  return (
    <WebPublishPopover
      targetKind="design"
      targetId={projectId}
      filePath={filePath}
      title={title}
      revisionKey={revisionKey}
      onNotify={onNotify}
      onCopyUrl={onCopyUrl}
      onOpenAccount={onOpenAccount}
    />
  );
}
