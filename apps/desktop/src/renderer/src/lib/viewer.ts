import { create } from "zustand";

type Viewing = { src: string; filename: string; opener: HTMLElement | null };
/** The image open in the viewer (null = closed). One viewer for the whole app; `opener` gets the focus back. */
export const useViewer = create<{ viewing: Viewing | null }>(() => ({ viewing: null }));

export const openViewer = (src: string, filename: string, opener: HTMLElement | null) => useViewer.setState({ viewing: { src, filename, opener } });
