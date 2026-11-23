import { Skeleton } from '../components/ui/Skeleton';
import { useI18n } from '../i18n/I18n';

export function RouteSurfaceFallback({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div
      className={compact ? 'om-route-fallback om-route-fallback-compact' : 'om-route-fallback'}
      role="status"
      aria-label={t('Loading…')}
    >
      <div className="om-route-fallback-inner">
        <Skeleton style={{ width: compact ? '48%' : '32%', height: 22 }} />
        <Skeleton style={{ width: '100%', height: compact ? 160 : 220, borderRadius: 12 }} />
        {!compact && (
          <div className="om-route-fallback-grid">
            <Skeleton style={{ width: '100%', height: 112, borderRadius: 10 }} />
            <Skeleton style={{ width: '100%', height: 112, borderRadius: 10 }} />
            <Skeleton style={{ width: '100%', height: 112, borderRadius: 10 }} />
          </div>
        )}
      </div>
    </div>
  );
}
