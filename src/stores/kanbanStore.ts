import { create } from "zustand";
import {
  getKanbanTasks,
  addKanbanTask,
  updateKanbanTask,
  deleteKanbanTask,
  addKanbanComment,
  deleteKanbanComment,
  getProjectNotes,
  saveProjectNotes,
  type KanbanTask,
  type KanbanStatus,
  type KanbanComment,
  type ProjectNotes,
} from "@/lib/tauri";

export type { KanbanTask, KanbanStatus, KanbanComment, ProjectNotes };

interface KanbanState {
  tasks: KanbanTask[];
  isLoading: boolean;
  notes: string;
  notesLoading: boolean;

  // Task actions
  loadTasks: (projectId: string) => Promise<void>;
  addTask: (projectId: string, title: string, description: string) => Promise<void>;
  updateTask: (taskId: string, updates: Partial<Pick<KanbanTask, "title" | "description" | "acceptanceCriteria" | "status">>) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  moveTask: (taskId: string, newStatus: KanbanStatus) => Promise<void>;
  addComment: (taskId: string, text: string) => Promise<void>;
  deleteComment: (taskId: string, commentId: string) => Promise<void>;

  // Notes actions
  loadNotes: (projectId: string) => Promise<void>;
  saveNotes: (projectId: string, content: string) => Promise<void>;
}

export const useKanbanStore = create<KanbanState>()((set, get) => ({
  tasks: [],
  isLoading: false,
  notes: "",
  notesLoading: false,

  loadTasks: async (projectId) => {
    set({ isLoading: true });
    try {
      const tasks = await getKanbanTasks(projectId);
      set({ tasks, isLoading: false });
    } catch (error) {
      console.error("[KanbanStore] Failed to load tasks:", error);
      set({ isLoading: false });
    }
  },

  addTask: async (projectId, title, description) => {
    try {
      const task = await addKanbanTask(projectId, title, description);
      set((state) => ({ tasks: [...state.tasks, task] }));
    } catch (error) {
      console.error("[KanbanStore] Failed to add task:", error);
    }
  },

  updateTask: async (taskId, updates) => {
    try {
      const updated = await updateKanbanTask(
        taskId,
        updates.title,
        updates.description,
        updates.acceptanceCriteria,
        updates.status
      );
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to update task:", error);
    }
  },

  deleteTask: async (taskId) => {
    try {
      await deleteKanbanTask(taskId);
      set((state) => ({ tasks: state.tasks.filter((t) => t.id !== taskId) }));
    } catch (error) {
      console.error("[KanbanStore] Failed to delete task:", error);
    }
  },

  moveTask: async (taskId, newStatus) => {
    const task = get().tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;
    try {
      const updated = await updateKanbanTask(taskId, undefined, undefined, undefined, newStatus);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to move task:", error);
    }
  },

  addComment: async (taskId, text) => {
    try {
      const updated = await addKanbanComment(taskId, text);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to add comment:", error);
    }
  },

  deleteComment: async (taskId, commentId) => {
    try {
      const updated = await deleteKanbanComment(taskId, commentId);
      set((state) => ({
        tasks: state.tasks.map((t) => (t.id === taskId ? updated : t)),
      }));
    } catch (error) {
      console.error("[KanbanStore] Failed to delete comment:", error);
    }
  },

  loadNotes: async (projectId) => {
    set({ notesLoading: true });
    try {
      const result = await getProjectNotes(projectId);
      set({ notes: result.content, notesLoading: false });
    } catch (error) {
      console.error("[KanbanStore] Failed to load notes:", error);
      set({ notesLoading: false });
    }
  },

  saveNotes: async (projectId, content) => {
    try {
      await saveProjectNotes(projectId, content);
      set({ notes: content });
    } catch (error) {
      console.error("[KanbanStore] Failed to save notes:", error);
    }
  },
}));
