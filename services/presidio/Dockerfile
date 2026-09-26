# Presidio analyzer with the recognizers ChainAim needs (spec V4). The stock
# configuration ships InAadhaarRecognizer and InPanRecognizer disabled; this
# image enables them. It also binds [::] so Railway's private network (IPv6)
# can reach it. Build context: services/presidio.
FROM mcr.microsoft.com/presidio-analyzer:2.2.362
USER root
COPY enable_recognizers.py /tmp/enable_recognizers.py
RUN python /tmp/enable_recognizers.py \
      /app/presidio_analyzer/conf/default_recognizers.yaml \
      /app/chainaim_recognizers.yaml \
      InAadhaarRecognizer InPanRecognizer \
 && chown 1001 /app/chainaim_recognizers.yaml \
 && rm /tmp/enable_recognizers.py
USER 1001
ENV RECOGNIZER_REGISTRY_CONF_FILE=/app/chainaim_recognizers.yaml
ENV PORT=3000
EXPOSE 3000
CMD ["sh", "-c", "exec gunicorn -w \"$WORKERS\" -b \"[::]:$PORT\" \"app:create_app()\""]
