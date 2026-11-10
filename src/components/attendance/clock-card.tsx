import { useEffect, useState } from "react";
import { Clock, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { elapsedSeconds, formatDuration, minutesBetween, pad2 } from "@/lib/attendance";
import type { TimeEntry } from "@/lib/types";

export function ClockCard({
  openEntry,
  busy,
  onClockIn,
  onClockOut,
}: {
  openEntry: TimeEntry | null;
  busy: boolean;
  onClockIn: () => void;
  onClockOut: (breakMinutes: number) => void;
}) {
  const [now, setNow] = useState(() => new Date());
  const [breakMinutes, setBreakMinutes] = useState("0");

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const dateLabel = new Intl.DateTimeFormat("he-IL", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);
  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const elapsed = openEntry ? elapsedSeconds(openEntry.start_time, now) : 0;
  const total = openEntry ? minutesBetween(openEntry.start_time, `${pad2(now.getHours())}:${pad2(now.getMinutes())}`) : null;
  const breakValue = Number(breakMinutes) || 0;
  const breakInvalid = total != null && total > 0 && breakValue >= total;

  return (
    <div className="overflow-hidden rounded-2xl border border-primary/20 bg-primary text-primary-foreground shadow-sm">
      <div className="flex flex-col gap-5 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-primary-foreground/70">{dateLabel}</p>
            <p className="num mt-1 text-4xl font-bold tracking-tight sm:text-5xl">{clock}</p>
          </div>
          <div className="flex size-11 items-center justify-center rounded-xl bg-primary-foreground/10">
            <Clock className="size-5" aria-hidden="true" />
          </div>
        </div>

        {openEntry ? (
          <div className="rounded-xl bg-primary-foreground/10 p-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="flex items-center gap-1.5 text-xs font-medium text-primary-foreground/80">
                  <Clock className="size-4" /> משמרת פעילה
                </p>
                <p className="num mt-1 text-3xl font-bold">{formatDuration(elapsed)}</p>
                <p className="mt-0.5 text-xs text-primary-foreground/70">
                  התחלה בשעה {openEntry.start_time?.slice(0, 5)}
                </p>
              </div>
              <div className="w-full sm:w-40">
                <label htmlFor="clock-break" className="mb-1 block text-xs font-medium text-primary-foreground/80">
                  הפסקה בדקות
                </label>
                <Input
                  id="clock-break"
                  type="number"
                  min="0"
                  step="1"
                  value={breakMinutes}
                  onChange={(e) => setBreakMinutes(e.target.value)}
                  className="h-11 border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground"
                />
              </div>
            </div>
            {breakInvalid ? (
              <p className="mt-2 text-xs font-medium text-amber-200">דקות ההפסקה גדולות משעות המשמרת.</p>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              className="mt-3 h-11 w-full"
              onClick={() => onClockOut(breakValue)}
              disabled={busy || breakInvalid}
            >
              <Square className="size-4" /> סיום משמרת
            </Button>
          </div>
        ) : (
          <div className="rounded-xl bg-primary-foreground/10 p-4">
            <p className="text-sm text-primary-foreground/80">
              אין משמרת פעילה. התחל משמרת כדי לתעד את שעות העבודה שלך.
            </p>
            <Button type="button" variant="secondary" className="mt-3 h-11 w-full" onClick={onClockIn} disabled={busy}>
              <Play className="size-4" /> התחלת משמרת
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
