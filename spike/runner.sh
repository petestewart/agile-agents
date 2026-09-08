#!/bin/bash
# Agile Agents spike runner. Executes *.cmd files dropped into queue/ (in name order),
# writes each one's output to spike-out/<name>.log, moves it to queue/done/.
# Start:  bash runner.sh      Stop: touch queue/STOP   (or ctrl-c)
cd "$(dirname "$0")" || exit 1
mkdir -p queue/done spike-out
echo "runner started $(date) pid $$" >> runner.status
while true; do
  for f in $(ls queue/*.cmd 2>/dev/null | sort); do
    name=$(basename "$f" .cmd)
    echo "running $name $(date)" >> runner.status
    bash "$f" > "spike-out/$name.log" 2>&1
    echo "exit $? $name $(date)" >> runner.status
    mv "$f" "queue/done/$name.cmd"
  done
  if [ -f queue/STOP ]; then rm -f queue/STOP; echo "stopped $(date)" >> runner.status; exit 0; fi
  sleep 3
done
