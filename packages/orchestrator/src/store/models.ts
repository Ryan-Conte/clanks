import type { ModelRepository } from '@clanks/models';
import { eq } from 'drizzle-orm';
import { model, modelPull } from './schema';
import type { Db } from './store';

/** The model manager's records, in SQLite. */
export function sqliteModelRepository(db: Db): ModelRepository {
  return {
    listModels: () => db.select().from(model).all(),

    getModel: (id) => db.select().from(model).where(eq(model.id, id)).get(),

    putModel: (record) => {
      db.insert(model)
        .values(record)
        .onConflictDoUpdate({ target: model.id, set: { ...record, id: undefined } })
        .run();
    },

    deleteModel: (id) => {
      db.delete(model).where(eq(model.id, id)).run();
    },

    listPulls: () => db.select().from(modelPull).all(),

    putPull: (record) => {
      db.insert(modelPull)
        .values(record)
        .onConflictDoUpdate({ target: modelPull.id, set: { ...record, id: undefined } })
        .run();
    },

    deletePull: (id) => {
      db.delete(modelPull).where(eq(modelPull.id, id)).run();
    },
  };
}
