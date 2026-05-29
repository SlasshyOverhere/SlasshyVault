import { useEffect } from "react";
import { LazyMotion, m } from "framer-motion";
import { BarChart3 } from "lucide-react";
import { AnalyticsData } from "@/services/api";
import { AnalyticsView } from "@/components/AnalyticsView";

const loadFeatures = () => import("framer-motion").then((mod) => mod.domAnimation);

interface FullHistoryViewProps {
  analyticsData?: AnalyticsData | null;
  onAnalyticsTabActive?: () => void;
}

export function FullHistoryView({
  analyticsData,
  onAnalyticsTabActive,
}: FullHistoryViewProps) {
  useEffect(() => {
    onAnalyticsTabActive?.();
  }, [onAnalyticsTabActive]);

  return (
    <LazyMotion features={loadFeatures}>
      <div className="pt-16">
        <m.div
          key="stats"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          {analyticsData ? (
            <AnalyticsView data={analyticsData} />
          ) : (
            <div className="flex min-h-[60vh] items-center justify-center rounded-[32px] border border-dashed border-white/10 bg-white/[0.02] p-8">
              <div className="text-center">
                <div className="mx-auto mb-4 rounded-2xl border border-white/10 bg-white/[0.05] p-4 w-fit">
                  <BarChart3 className="size-8 text-white/40" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-1">Loading analytics…</h3>
              </div>
            </div>
          )}
        </m.div>
      </div>
    </LazyMotion>
  );
}
