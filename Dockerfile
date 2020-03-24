from node:13-buster-slim

RUN apt-get update && \
	apt-get install -y \
	make \
	python \
	sqlite3 \
	g++

COPY ./.sqliterc ~/

WORKDIR /app

# .env and sqlite3 file location.
RUN mkdir -p /cfg
VOLUME /cfg

COPY . .

RUN npm ci

ENTRYPOINT ["npm", "run"]
CMD ["cmd/serve"]
