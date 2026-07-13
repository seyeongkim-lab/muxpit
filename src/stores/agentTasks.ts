import { create } from "zustand";
import {
  attentionAgentTasks,
  reduceAgentTask,
  type AgentTask,
  type AgentTaskUpdate,
} from "../utils/agentTask.ts";

interface AgentTaskState {
  tasks: AgentTask[];
  updateTask: (update: AgentTaskUpdate) => void;
  acknowledge: (id: string) => void;
  clearTasks: () => void;
  attentionCount: () => number;
}

export const useAgentTaskStore = create<AgentTaskState>((set, get) => ({
  tasks: [],
  updateTask: (update) => set((state) => ({ tasks: reduceAgentTask(state.tasks, update) })),
  acknowledge: (id) =>
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id ? { ...task, acknowledged: true } : task,
      ),
    })),
  clearTasks: () => set({ tasks: [] }),
  attentionCount: () => attentionAgentTasks(get().tasks).length,
}));
