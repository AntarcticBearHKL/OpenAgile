import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.OPENAGILE_MCP_URL || 'http://127.0.0.1:8787/mcp');
const client = new Client({ name: 'openagile-harness-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(url);

await client.connect(transport);
console.log('SESSION:', transport.sessionId);

const tools = await client.listTools();
console.log('TOOL_COUNT:', tools.tools.length);
console.log('TOOLS:', tools.tools.map((t) => t.name).join(','));

const created = await client.callTool({
  name: 'create_task',
  arguments: { title: 'MCP smoke task', description: 'created via MCP', priority: 'high', labels: ['Task'] }
});
console.log('CREATE_TASK:', created.content?.[0]?.text || JSON.stringify(created));
const createdId = JSON.parse(created.content[0].text).id;

await client.callTool({ name: 'add_subtask', arguments: { taskId: createdId, title: 'smoke subtask' } });
await client.callTool({ name: 'move_task', arguments: { taskId: createdId, column: 'In Progress' } });

const list = await client.callTool({ name: 'list_tasks', arguments: {} });
console.log('LIST_TASKS:', list.content?.[0]?.text || JSON.stringify(list));

await client.close();
console.log('SMOKE_OK');
process.exit(0);
