const fs = require('node:fs')
const [file, ...args] = process.argv.slice(2)
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
fs.appendFileSync(file + '.calls', JSON.stringify(args) + '\n')
const emit = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value))
const fail = message => { process.stderr.write(message); process.exit(1) }
if (args[0] === 'context') {
  if (args[1] === 'show') emit(state.context)
  else emit([{ Endpoints: { docker: { Host: state.endpoint } } }])
} else {
  if (args[0] !== '--host' || args[1] !== state.endpoint) fail('incorrect endpoint')
  const command = args.slice(2)
  if (state.offline) fail('Cannot connect to the Docker daemon')
  if (command[0] === 'info') emit(JSON.stringify(state.daemon))
  else if (command[1] === 'ls') {
    if (state.badList) emit('{}')
    else if (command.includes('--quiet')) emit(state.rows.filter(c => c.ID === command.at(-1).slice(3)).map(c => c.ID).join('\n'))
    else emit(state.rows.map(c => JSON.stringify(c)).join('\n'))
  } else if (command[1] === 'stats') {
    if (state.statsFail) fail('stats unavailable')
    emit(state.rows.filter(c => c.State === 'running').map(c => JSON.stringify({ Container: c.ID, CPUPerc: '0.00%', MemUsage: '2MiB / 1GiB' })).join('\n'))
  } else {
    const id = command.at(-1), c = state.rows.find(c => c.ID === id)
    if (!c) fail('No such container')
    if (command[1] === 'inspect') emit([{ Id: id, State: { Status: c.State, Running: ['running', 'paused', 'restarting'].includes(c.State) } }])
    else if (command[1] === 'logs') {
      if (state.logsFail) fail('logging driver does not support reading')
      emit('actual stdout\n'); process.stderr.write('actual stderr\n')
    } else if (['start', 'stop', 'restart', 'rm'].includes(command[1])) {
      if (state.failIds?.includes(id)) fail('permission denied')
      if (command[1] === 'rm') {
        if (['running', 'paused', 'restarting'].includes(c.State)) fail('running container')
        state.rows = state.rows.filter(row => row.ID !== id)
      } else if (!state.noChange) { c.State = command[1] === 'stop' ? 'exited' : 'running'; c.Status = c.State }
      fs.writeFileSync(file, JSON.stringify(state)); emit(id)
    } else fail('unexpected command')
  }
}
