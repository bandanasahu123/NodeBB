FROM node:lts

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

ARG NODE_ENV
ENV NODE_ENV $NODE_ENV

COPY install/package.json /usr/src/app/package.json

RUN npm install --only=prod && \
    npm cache clean --force

COPY local_modules/ /usr/src/app/node_modules/

RUN cd /usr/src/app/node_modules/nodebb-plugin-sunbird-oidc &&  \
    npm install && \
    cd .. && \
    cd nodebb-plugin-telemetry-plugin && \
    npm install && \
    cd ..

COPY . /usr/src/app

ENV NODE_ENV=production \
    daemon=false \
    silent=false

EXPOSE 4567

CMD node ./nodebb build ;  node ./nodebb start
