import { type BoardSnapshot, LEAD_CLANK } from '@clanks/core';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { useCrew } from '../../lib/crew';
import { useModels } from '../../lib/models';
import { useNav } from '../../lib/nav';
import { useTRPC } from '../../lib/trpc';
import { Avatar } from '../Avatar';
import { ModelPicker } from '../ModelPicker';
import { Button, ErrorText, Panel, Row, Switch, inputClass } from '../ui';

/** A project's name, workspace, crew and models, and deleting it. */
export function ProjectSettings({ snapshot }: { snapshot: BoardSnapshot }) {
  const trpc = useTRPC();
  const { go } = useNav();
  const crew = useCrew();
  const models = useModels();
  const { project } = snapshot;
  const [name, setName] = useState(project.name);
  const [brief, setBrief] = useState(project.brief);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const update = useMutation(trpc.projects.update.mutationOptions());
  const setMember = useMutation(trpc.projects.setMember.mutationOptions());
  const setMemberModel = useMutation(trpc.projects.setMemberModel.mutationOptions());
  const openFolder = useMutation(trpc.projects.openFolder.mutationOptions());
  const remove = useMutation(
    trpc.projects.delete.mutationOptions({ onSuccess: () => go({ page: 'home' }) }),
  );
  const changed = name.trim() !== project.name || brief.trim() !== project.brief;
  const crewError = setMember.error ?? setMemberModel.error;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-10 py-8">
        <Panel title="Project">
          <input
            aria-label="Name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            aria-label="What you're making"
            placeholder="A line about what you're making"
            className={inputClass}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <span className="flex gap-2">
            <Button
              disabled={!changed || !name.trim() || update.isPending}
              onClick={() =>
                update.mutate({ id: project.id, patch: { name: name.trim(), brief: brief.trim() } })
              }
            >
              Save
            </Button>
          </span>
          {update.error && <ErrorText>{update.error.message}</ErrorText>}
        </Panel>

        <Panel
          title="Workspace"
          description="The crew works on copies of it, each on a branch of its own. Your own checkout is never touched."
          actions={
            <Button size="sm" onClick={() => openFolder.mutate(project.id)}>
              Open folder
            </Button>
          }
        >
          <dl className="divide-y divide-line text-sm">
            <Row label="Folder">
              <span className="font-mono text-[13px] break-all">{project.folder}</span>
            </Row>
            {project.repo && (
              <Row label="GitHub">
                <a
                  href={project.repo.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="font-mono text-[13px] text-accent hover:underline"
                >
                  {project.repo.fullName}
                </a>
              </Row>
            )}
            <Row label="Ticket keys">
              <span className="font-mono text-[13px]">
                {project.key}-1, {project.key}-2, …
              </span>
            </Row>
          </dl>
        </Panel>

        <Panel
          title="Crew and models"
          description="Who works on this project, and the model each runs on here. Atlas leads every project, so it's always in."
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-dim">The crew's model in this project</span>
            <ModelPicker
              value={project.model}
              onChange={(model) => update.mutate({ id: project.id, patch: { model } })}
              emptyLabel={`Each clank's own, or the crew's model${models?.crewModel ? ` (${models.crewModel})` : ''}`}
            />
          </label>
          <ul className="flex flex-col divide-y divide-line">
            {crew.map((clank) => {
              const member = project.crew.find((m) => m.clankId === clank.id);
              const lead = clank.id === LEAD_CLANK;
              return (
                <li key={clank.id} className="grid grid-cols-[1fr_16rem] items-center gap-4 py-3">
                  <label className="flex items-center gap-3">
                    <Switch
                      checked={member !== undefined}
                      disabled={lead}
                      label={`${clank.name} in this project`}
                      onChange={(included) =>
                        setMember.mutate({ id: project.id, clankId: clank.id, included })
                      }
                    />
                    <Avatar colour={clank.avatar} size="xs" />
                    <span className="flex items-baseline gap-2 text-sm">
                      {clank.name}
                      <span className="text-[12px] text-dim">{clank.role}</span>
                    </span>
                  </label>
                  {member ? (
                    <ModelPicker
                      value={member.model}
                      onChange={(model) =>
                        setMemberModel.mutate({ id: project.id, clankId: clank.id, model })
                      }
                      emptyLabel="The project's model"
                    />
                  ) : (
                    <span className="text-[12px] text-dim">Not in this project</span>
                  )}
                </li>
              );
            })}
          </ul>
          {crewError && <ErrorText>{crewError.message}</ErrorText>}
        </Panel>

        <Panel
          title="Delete the project"
          description="Its board, spec, chats and runs go. The folder stays, and so do the branches the crew worked on."
        >
          {confirmDelete ? (
            <span className="flex gap-2">
              <Button
                variant="danger"
                disabled={remove.isPending}
                onClick={() => remove.mutate(project.id)}
              >
                Delete {project.name}
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </span>
          ) : (
            <Button variant="danger" className="self-start" onClick={() => setConfirmDelete(true)}>
              Delete project…
            </Button>
          )}
          {remove.error && <ErrorText>{remove.error.message}</ErrorText>}
        </Panel>
      </div>
    </div>
  );
}
