import { useEffect } from "react";
import { System } from "@wailsio/runtime";

/** Ширина полосы у края окна, где курсор показывает, что окно можно растянуть. */
const EDGE = 6;

/** Углы чуть шире полосы: так в них проще попасть, как и в нативном окне. */
const CORNER = 12;

type ResizeCursor = "ew" | "ns" | "nwse" | "nesw";

function cursorAt(x: number, y: number): ResizeCursor | null {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const left = x < EDGE;
    const right = x > width - EDGE;
    const top = y < EDGE;
    const bottom = y > height - EDGE;

    if (left || right || top || bottom) {
        const inLeftCorner = x < CORNER;
        const inRightCorner = x > width - CORNER;
        const inTopCorner = y < CORNER;
        const inBottomCorner = y > height - CORNER;

        if ((inLeftCorner || inRightCorner) && (inTopCorner || inBottomCorner)) {
            const descending = (inLeftCorner && inTopCorner) || (inRightCorner && inBottomCorner);
            return descending ? "nwse" : "nesw";
        }
    }

    if (left || right) return "ew";
    if (top || bottom) return "ns";
    return null;
}

/**
 * macOS сам не подсказывает курсором, что окно можно растянуть за край: вебвью занимает всё окно
 * и показывает обычную стрелку. Windows и Linux закрывает рантайм Wails, а здесь полоса у края
 * подсвечивается вручную — иначе непонятно, где хватать окно, хотя тянуть за край можно.
 */
export function useWindowResizeCursor() {
    useEffect(() => {
        if (!System.IsMac()) return;

        let current: ResizeCursor | null = null;

        const apply = (cursor: ResizeCursor | null) => {
            if (cursor === current) return;
            current = cursor;

            const root = document.documentElement;
            if (cursor) {
                root.dataset.windowResize = cursor;
            } else {
                delete root.dataset.windowResize;
            }
        };

        const handleMove = (event: MouseEvent) => {
            apply(cursorAt(event.clientX, event.clientY));
        };
        const reset = () => apply(null);
        const root = document.documentElement;

        window.addEventListener("mousemove", handleMove, {passive: true});
        root.addEventListener("mouseleave", reset);
        window.addEventListener("blur", reset);

        return () => {
            window.removeEventListener("mousemove", handleMove);
            root.removeEventListener("mouseleave", reset);
            window.removeEventListener("blur", reset);
            delete root.dataset.windowResize;
        };
    }, []);
}
