GITHEAD		:= $(shell git rev-parse HEAD | head -c8)
IMAGE_NAME	:= witty:$(GITHEAD)

.PHONY: %
%:
	@echo Creating image for workspace $@...
	make image-$@

.PHONY: image-%
image-%:
	make dist/witty-$(GITHEAD)-$@.tar

dist/witty-%.tar: cleangit
	docker inspect --type=image $(IMAGE_NAME) > /dev/null 2>&1 \
	|| docker build -t $(IMAGE_NAME) .
	docker save -o $@ $(IMAGE_NAME)
	@echo OK: Saved image to $@

.PHONY: cleangit
cleangit:
	@git diff-index --quiet HEAD \
	|| (echo "Not building image: uncommitted changes." && exit 1)
