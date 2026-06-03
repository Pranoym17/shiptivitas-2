import express from 'express';
import Database from 'better-sqlite3';

const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  res.header('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.get('/', (req, res) => {
  return res.status(200).send({'message': 'SHIPTIVITY API. Read documentation to see API docs'});
});

// We are keeping one connection alive for the rest of the life application for simplicity
const db = new Database('./clients.db');

// Don't forget to close connection when server gets terminated
const closeDb = () => db.close();
process.on('SIGTERM', closeDb);
process.on('SIGINT', closeDb);

/**
 * Validate id input
 * @param {any} id
 */
const validateId = (id) => {
  if (Number.isNaN(id)) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Id can only be integer.',
      },
    };
  }
  const client = db.prepare('select * from clients where id = ? limit 1').get(id);
  if (!client) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid id provided.',
      'long_message': 'Cannot find client with that id.',
      },
    };
  }
  return {
    valid: true,
  };
}

/**
 * Validate priority input
 * @param {any} priority
 */
const validatePriority = (priority) => {
  if (Number.isNaN(priority) || priority < 1) {
    return {
      valid: false,
      messageObj: {
      'message': 'Invalid priority provided.',
      'long_message': 'Priority can only be positive integer.',
      },
    };
  }
  return {
    valid: true,
  };
};

const validateStatus = (status) => {
  if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
    return {
      valid: false,
      messageObj: {
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      },
    };
  }
  return {
    valid: true,
  };
};

const sortByPriority = (clients) => clients.slice().sort((a, b) => a.priority - b.priority);

const updateLanePriorities = (laneClients) => laneClients.map((laneClient, index) => ({
  ...laneClient,
  priority: index + 1,
}));

const persistClients = db.transaction((clientsToPersist) => {
  const statement = db.prepare('update clients set status = ?, priority = ? where id = ?');
  clientsToPersist.forEach((client) => {
    statement.run(client.status, client.priority, client.id);
  });
});

/**
 * Get all of the clients. Optional filter 'status'
 * GET /api/v1/clients?status={status} - list all clients, optional parameter status: 'backlog' | 'in-progress' | 'complete'
 */
app.get('/api/v1/clients', (req, res) => {
  const status = req.query.status;
  if (status) {
    // status can only be either 'backlog' | 'in-progress' | 'complete'
    if (status !== 'backlog' && status !== 'in-progress' && status !== 'complete') {
      return res.status(400).send({
        'message': 'Invalid status provided.',
        'long_message': 'Status can only be one of the following: [backlog | in-progress | complete].',
      });
    }
    const clients = db.prepare('select * from clients where status = ?').all(status);
    return res.status(200).send(clients);
  }
  const statement = db.prepare('select * from clients');
  const clients = statement.all();
  return res.status(200).send(clients);
});

/**
 * Get a client based on the id provided.
 * GET /api/v1/clients/{client_id} - get client by id
 */
app.get('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    res.status(400).send(messageObj);
  }
  return res.status(200).send(db.prepare('select * from clients where id = ?').get(id));
});

/**
 * Update client information based on the parameters provided.
 * When status is provided, the client status will be changed
 * When priority is provided, the client priority will be changed with the rest of the clients accordingly
 * Note that priority = 1 means it has the highest priority (should be on top of the swimlane).
 * No client on the same status should not have the same priority.
 * This API should return list of clients on success
 *
 * PUT /api/v1/clients/{client_id} - change the status of a client
 *    Data:
 *      status (optional): 'backlog' | 'in-progress' | 'complete',
 *      priority (optional): integer,
 *
 */
app.put('/api/v1/clients/:id', (req, res) => {
  const id = parseInt(req.params.id , 10);
  const { valid, messageObj } = validateId(id);
  if (!valid) {
    return res.status(400).send(messageObj);
  }

  let { status, priority } = req.body;
  if (status !== undefined) {
    const statusValidation = validateStatus(status);
    if (!statusValidation.valid) {
      return res.status(400).send(statusValidation.messageObj);
    }
  }

  if (priority !== undefined) {
    priority = parseInt(priority, 10);
    const priorityValidation = validatePriority(priority);
    if (!priorityValidation.valid) {
      return res.status(400).send(priorityValidation.messageObj);
    }
  }

  let clients = db.prepare('select * from clients').all();
  const client = clients.find(client => client.id === id);
  const nextStatus = status || client.status;
  const isLaneChange = nextStatus !== client.status;
  const isPriorityChange = priority !== undefined && priority !== client.priority;

  /* ---------- Update code below ----------*/
  if (!isLaneChange && !isPriorityChange) {
    return res.status(200).send(clients);
  }

  const sourceLane = sortByPriority(
    clients.filter((laneClient) => laneClient.status === client.status && laneClient.id !== client.id),
  );
  const targetLaneBase = isLaneChange
    ? sortByPriority(clients.filter((laneClient) => laneClient.status === nextStatus))
    : sourceLane;

  let targetPriority = priority;
  if (targetPriority === undefined) {
    targetPriority = isLaneChange ? targetLaneBase.length + 1 : client.priority;
  }

  if (targetPriority > targetLaneBase.length + 1) {
    targetPriority = targetLaneBase.length + 1;
  }

  const movedClient = {
    ...client,
    status: nextStatus,
    priority: targetPriority,
  };

  const targetLane = targetLaneBase.slice();
  targetLane.splice(targetPriority - 1, 0, movedClient);

  const updatedSourceLane = updateLanePriorities(sourceLane);
  const updatedTargetLane = updateLanePriorities(targetLane);
  const clientsToPersist = isLaneChange
    ? updatedSourceLane.concat(updatedTargetLane)
    : updatedTargetLane;

  persistClients(clientsToPersist);

  clients = db.prepare('select * from clients').all();



  return res.status(200).send(clients);
});

app.listen(3001);
console.log('app running on port ', 3001);
