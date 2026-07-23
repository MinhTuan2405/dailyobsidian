import { useEffect, useState } from "react";

import type { Task } from "@obsidian-workbench/shared";

import type { WorkbenchBridge } from "../bridge/workbench-bridge.js";

function sectionFor(task: Task): string {
  const today = new Date().toISOString().slice(0, 10);
  if (task.status === "completed") return "Completed";
  if (task.dueDate !== undefined && task.dueDate < today) return "Overdue";
  if (task.dueDate === today) return "Today";
  if (task.dueDate !== undefined) return "Upcoming";
  return "No due date";
}

export function TaskDashboard({
  bridge,
  vaultId,
  onToggle,
}: {
  bridge: WorkbenchBridge;
  vaultId: string;
  onToggle: (task: Task) => Promise<void>;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string>();
  const sections = ["Overdue", "Today", "Upcoming", "No due date", "Completed"];

  useEffect(() => {
    let current = true;
    void bridge
      .listTasks({ vaultId, limit: 200 })
      .then((items) => {
        if (current) setTasks(items);
      })
      .catch(() => {
        if (current) setError("Tasks are unavailable for this vault.");
      });
    return () => {
      current = false;
    };
  }, [bridge, vaultId]);

  return (
    <section className="screen task-screen">
      <header className="screen-header">
        <div>
          <p className="eyebrow">06 / Task register</p>
          <h1>Commitments in context</h1>
        </div>
        <label className="compact-filter">
          <span>Project or tag</span>
          <input placeholder="#project" />
        </label>
      </header>
      {error ? <p className="inline-error">{error}</p> : null}
      <div className="task-columns">
        {sections.map((section) => {
          const matching = tasks.filter((task) => sectionFor(task) === section);
          return (
            <section className="task-column" key={section}>
              <h2>
                {section} <span>{matching.length}</span>
              </h2>
              {matching.map((task) => (
                <article className="task-card" key={task.taskId}>
                  <p>{task.text}</p>
                  <code>{task.path}</code>
                  <div>
                    <button
                      className="text-button"
                      onClick={() => void onToggle(task)}
                    >
                      {task.status === "completed" ? "Reopen" : "Complete"}
                    </button>
                    <button className="text-button">Edit due date</button>
                    <button className="text-button">Open source</button>
                  </div>
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </section>
  );
}
